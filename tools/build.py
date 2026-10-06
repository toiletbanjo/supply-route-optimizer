#!/usr/bin/env python3
"""Build the single-file prototype: prototype/supply-route-app.html.

Python 3 standard library only. Reads tools/manifest.json and fills the <!--INLINE:name-->
markers in src/index.html:

  <!--INLINE:lib-css-->  third-party CSS (leaflet.css, its url(images/*.png) as data URIs)
  <!--INLINE:app-css-->  src/styles.css
  <!--INLINE:worker-->   <script type="text/plain" id="worker-src">: the 'worker' group, concatenated
  <!--INLINE:highs-->    <script type="text/plain" id="highs-js"> (node_modules/highs/build/highs.js)
                         <script type="text/plain" id="highs-wasm-gz"> (highs.wasm, gzip -9, base64)
  <!--INLINE:lib-js-->   third-party scripts (leaflet, milsymbol, mgrs) + SRO.lib.leafletImages
  <!--INLINE:main-->     SRO.build info, then one <script> per 'main' group file, in manifest order

Rules (DESIGN.md sections 1, 6, 7, 9):
  - A .json file is wrapped as SRO.data.<name> = <json>; where <name> is the file name before
    the first dot (same rule as tests/load.mjs wrapSource).
  - Manifest entries ending in '?' are optional and skipped silently when missing. Other missing
    files are skipped with a WARNING line, or fail the build with --strict.
  - .js / .json files under src/ that no manifest group lists get a WARNING line (they would
    otherwise be left out of the build without anyone noticing).
  - --out is relative to the current directory; the default output lives in the repo.
  - '</script' inside inlined code is rewritten to '<\\/script' (and '</style' to '<\\/style' in
    CSS); the build asserts none remain.
  - Deterministic: the same inputs give a byte-identical file (no timestamps; gzip mtime = 0).

The 'libs' group in the manifest is optional: when it is empty the built-in list below is used.

Usage:
  python3 tools/build.py [--strict] [--out PATH] [--exclude GLOB ...] [--quiet]
"""
import argparse
import base64
import fnmatch
import gzip
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = 'tools/manifest.json'
TEMPLATE = 'src/index.html'
APP_CSS = 'src/styles.css'
DEFAULT_OUT = 'prototype/supply-route-app.html'

# Pinned third-party files (package.json pins the versions). CSS goes to lib-css, JS to lib-js.
DEFAULT_LIBS = [
    'node_modules/leaflet/dist/leaflet.css',
    'node_modules/leaflet/dist/leaflet.js',
    'node_modules/milsymbol/dist/milsymbol.js',
    'node_modules/mgrs/dist/mgrs.min.js',
]
LIB_PACKAGES = ['leaflet', 'milsymbol', 'mgrs', 'highs']
HIGHS_JS = 'node_modules/highs/build/highs.js'
HIGHS_WASM = 'node_modules/highs/build/highs.wasm'
LEAFLET_IMAGE_DIR = 'node_modules/leaflet/dist/images'
# L.Icon.Default options; boot.js sets L.Icon.Default.imagePath = '' and merges these.
LEAFLET_ICON_OPTIONS = [
    ('iconUrl', 'marker-icon.png'),
    ('iconRetinaUrl', 'marker-icon-2x.png'),
    ('shadowUrl', 'marker-shadow.png'),
]
MARKERS = ['lib-css', 'app-css', 'worker', 'highs', 'lib-js', 'main']

SCRIPT_CLOSE = re.compile(r'</(script)', re.IGNORECASE)
STYLE_CLOSE = re.compile(r'</(style)', re.IGNORECASE)
SOURCE_MAP = re.compile(r'^[ \t]*//[#@] sourceMappingURL=[^\r\n]*$', re.MULTILINE)
CSS_SOURCE_MAP = re.compile(r'/\*[#@] sourceMappingURL=[^*]*\*/')


class BuildError(Exception):
    pass


class Build:
    def __init__(self, strict=False, excludes=None, quiet=False):
        self.strict = strict
        self.excludes = excludes or []
        self.quiet = quiet
        self.warnings = []
        self.missing = []
        self.included = []
        self.sizes = []          # (label, bytes) for the report
        self.hasher = hashlib.sha256()

    # ---- helpers -------------------------------------------------------------------------------
    def log(self, msg):
        if not self.quiet:
            print(msg)

    def warn(self, msg):
        self.warnings.append(msg)
        print('WARNING: ' + msg, file=sys.stderr)

    def path(self, rel):
        return os.path.join(ROOT, rel)

    def read_text(self, rel):
        with open(self.path(rel), 'r', encoding='utf-8') as f:
            text = f.read()
        if text.startswith('﻿'):
            text = text[1:]
        self.hasher.update(rel.encode('utf-8') + b'\0' + text.encode('utf-8') + b'\0')
        return text

    def read_bytes(self, rel):
        with open(self.path(rel), 'rb') as f:
            data = f.read()
        self.hasher.update(rel.encode('utf-8') + b'\0' + data + b'\0')
        return data

    def excluded(self, rel):
        return any(fnmatch.fnmatch(rel, pat) for pat in self.excludes)

    def resolve(self, entry, group):
        """Manifest entry -> relative path, or None when it is skipped."""
        optional = entry.endswith('?')
        rel = entry[:-1] if optional else entry
        if self.excluded(rel):
            self.log('  skip (excluded) ' + rel)
            return None
        if os.path.isfile(self.path(rel)):
            return rel
        if optional:
            return None
        msg = "missing file '%s' (manifest group '%s')" % (rel, group)
        if self.strict:
            raise BuildError(msg)
        self.warn(msg + ', skipped')
        if rel not in self.missing:
            self.missing.append(rel)
        return None

    def script_safe(self, text, label):
        """Make text safe inside <script>...</script>."""
        text = SCRIPT_CLOSE.sub(lambda m: '<\\/' + m.group(1), text)
        if '<!--' in text:
            # '<!--' followed later by '<script' would switch the HTML parser into the
            # double-escaped state; '<\!--' is the same string inside JS string literals.
            self.warn("'<!--' found in %s; rewritten to '<\\!--'" % label)
            text = text.replace('<!--', '<\\!--')
        if SCRIPT_CLOSE.search(text):
            raise BuildError("'</script' still present in " + label)
        return text

    def style_safe(self, text, label):
        text = STYLE_CLOSE.sub(lambda m: '<\\/' + m.group(1), text)
        if STYLE_CLOSE.search(text):
            raise BuildError("'</style' still present in " + label)
        return text

    def module_source(self, rel):
        """File text as it runs on the page or in the worker (.json wrapped as SRO.data.<name>)."""
        text = self.read_text(rel)
        if rel.endswith('.json'):
            try:
                json.loads(text)
            except ValueError as e:
                raise BuildError('invalid JSON in %s: %s' % (rel, e))
            name = os.path.basename(rel).split('.')[0]
            return ('(function(root){var SRO=root.SRO=root.SRO||{};SRO.data=SRO.data||{};SRO.data['
                    + json.dumps(name) + ']=' + text
                    + ';})(typeof self!=="undefined"?self:globalThis);')
        return text

    def data_uri(self, rel, mime):
        return 'data:%s;base64,%s' % (mime, base64.b64encode(self.read_bytes(rel)).decode('ascii'))

    def package_version(self, name):
        rel = 'node_modules/%s/package.json' % name
        if not os.path.isfile(self.path(rel)):
            return None
        with open(self.path(rel), 'r', encoding='utf-8') as f:
            return json.load(f).get('version')

    # ---- sections ------------------------------------------------------------------------------
    def lib_files(self, manifest):
        libs = manifest.get('libs') or DEFAULT_LIBS
        out = []
        for entry in libs:
            rel = self.resolve(entry, 'libs')
            if rel:
                out.append(rel)
        return out

    def section_lib_css(self, libs):
        parts = []
        for rel in libs:
            if not rel.endswith('.css'):
                continue
            css = self.read_text(rel)
            css = CSS_SOURCE_MAP.sub('', css)
            base = os.path.dirname(rel)

            def to_data_uri(m):
                ref = m.group(2)
                if ref.startswith(('data:', '#', 'http:', 'https:')):
                    return m.group(0)
                img = os.path.normpath(os.path.join(base, ref)).replace(os.sep, '/')
                if not os.path.isfile(self.path(img)):
                    self.warn('%s: url(%s) not found, left as is' % (rel, ref))
                    return m.group(0)
                mime = 'image/png' if img.endswith('.png') else 'image/svg+xml' if img.endswith('.svg') else 'application/octet-stream'
                return 'url("%s")' % self.data_uri(img, mime)

            css = re.sub(r'url\((["\']?)([^)"\']+)\1\)', to_data_uri, css)
            css = self.style_safe(css, rel)
            parts.append('<style data-src="%s">\n%s\n</style>' % (rel, css.strip()))
            self.included.append(rel)
            self.sizes.append((rel, len(css.encode('utf-8'))))
        return '\n'.join(parts)

    def section_app_css(self):
        rel = self.resolve(APP_CSS, 'app-css')
        if not rel:
            return ''
        css = self.style_safe(self.read_text(rel), rel)
        self.included.append(rel)
        self.sizes.append((rel, len(css.encode('utf-8'))))
        return '<style data-src="%s">\n%s\n</style>' % (rel, css.strip())

    def section_lib_js(self, libs):
        parts = []
        for rel in libs:
            if not rel.endswith('.js'):
                continue
            js = SOURCE_MAP.sub('', self.read_text(rel))
            js = self.script_safe(js, rel)
            parts.append('<script data-src="%s">\n%s\n</script>' % (rel, js.strip()))
            self.included.append(rel)
            self.sizes.append((rel, len(js.encode('utf-8'))))
            if rel.endswith('leaflet/dist/leaflet.js'):
                parts.append(self.leaflet_images())
        return '\n'.join(parts)

    def leaflet_images(self):
        opts = []
        for key, fname in LEAFLET_ICON_OPTIONS:
            rel = LEAFLET_IMAGE_DIR + '/' + fname
            if os.path.isfile(self.path(rel)):
                opts.append('%s:%s' % (json.dumps(key), json.dumps(self.data_uri(rel, 'image/png'))))
            else:
                self.warn('leaflet marker image missing: ' + rel)
        js = ('(function(root){var SRO=root.SRO=root.SRO||{};SRO.lib=SRO.lib||{};'
              'SRO.lib.leafletImages={' + ','.join(opts) + '};})(typeof self!=="undefined"?self:globalThis);')
        self.sizes.append(('leaflet marker images', len(js)))
        return '<script data-src="leaflet-images">\n' + js + '\n</script>'

    def section_worker(self, manifest):
        chunks = []
        for entry in manifest.get('worker', []):
            rel = self.resolve(entry, 'worker')
            if not rel:
                continue
            src = self.module_source(rel)
            chunks.append('/* ==== %s ==== */\n%s\n;' % (rel, src.rstrip()))
            self.included.append('worker:' + rel)
        body = self.script_safe('\n'.join(chunks), 'worker group')
        self.sizes.append(('worker group (%d files)' % len(chunks), len(body.encode('utf-8'))))
        return '<script type="text/plain" id="worker-src">\n' + body + '\n</script>'

    def section_highs(self):
        parts = []
        js_rel = self.resolve(HIGHS_JS, 'highs')
        if js_rel:
            js = self.read_text(js_rel)
            if SCRIPT_CLOSE.search(js) or '<!--' in js:
                raise BuildError(js_rel + " contains '</script' or '<!--'; it must be inlined verbatim")
            parts.append('<script type="text/plain" id="highs-js">' + js + '</script>')
            self.included.append(js_rel)
            self.sizes.append((js_rel, len(js.encode('utf-8'))))
        wasm_rel = self.resolve(HIGHS_WASM, 'highs')
        if wasm_rel:
            raw = self.read_bytes(wasm_rel)
            gz = gzip.compress(raw, compresslevel=9, mtime=0)
            b64 = base64.b64encode(gz).decode('ascii')
            parts.append('<script type="text/plain" id="highs-wasm-gz">' + b64 + '</script>')
            self.included.append(wasm_rel)
            self.sizes.append(('%s (%d B -> gzip %d B -> base64)' % (wasm_rel, len(raw), len(gz)), len(b64)))
        return '\n'.join(parts)

    def section_main(self, manifest):
        files = []
        for entry in manifest.get('main', []):
            rel = self.resolve(entry, 'main')
            if rel:
                files.append(rel)
        scripts = []
        total = 0
        for rel in files:
            src = self.module_source(rel).rstrip()
            src = self.script_safe(src + '\n//# sourceURL=' + rel, rel)
            scripts.append('<script data-src="%s">\n%s\n</script>' % (rel, src))
            self.included.append(rel)
            total += len(src.encode('utf-8'))
        self.sizes.append(('main group (%d files)' % len(files), total))
        return scripts

    def build_info(self):
        libs = {}
        for name in LIB_PACKAGES:
            v = self.package_version(name)
            if v:
                libs[name] = v
        info = {
            'hash': self.hasher.hexdigest()[:12],
            'libs': libs,
            'missing': self.missing,
        }
        js = ('(function(root){var SRO=root.SRO=root.SRO||{};SRO.build=' + json.dumps(info, sort_keys=True)
              + ';})(typeof self!=="undefined"?self:globalThis);')
        return '<script data-src="build-info">\n' + self.script_safe(js, 'build info') + '\n</script>'

    def unlisted_sources(self, manifest):
        """Source files under src/ that no manifest group lists (easy to forget when adding a file)."""
        listed = set()
        for group in ('libs', 'worker', 'main'):
            for entry in manifest.get(group) or []:
                listed.add(entry[:-1] if entry.endswith('?') else entry)
        out = []
        for dirpath, dirnames, filenames in os.walk(self.path('src')):
            dirnames.sort()
            for name in sorted(filenames):
                if not name.endswith(('.js', '.json')):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, name), ROOT).replace(os.sep, '/')
                if rel not in listed and not self.excluded(rel):
                    out.append(rel)
        return out

    # ---- main ----------------------------------------------------------------------------------
    def run(self, out_rel):
        with open(self.path(MANIFEST), 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        template = self.read_text(TEMPLATE)
        for name in MARKERS:
            n = template.count('<!--INLINE:%s-->' % name)
            if n != 1:
                raise BuildError('%s must contain <!--INLINE:%s--> exactly once (found %d)' % (TEMPLATE, name, n))
        unknown = sorted(set(re.findall(r'<!--INLINE:([\w.-]+)-->', template)) - set(MARKERS))
        if unknown:
            raise BuildError('unknown INLINE marker(s) in %s: %s' % (TEMPLATE, ', '.join(unknown)))

        for rel in self.unlisted_sources(manifest):
            self.warn("'%s' is not listed in %s, so it is not in the build" % (rel, MANIFEST))

        libs = self.lib_files(manifest)
        sections = {
            'lib-css': self.section_lib_css(libs),
            'app-css': self.section_app_css(),
            'worker': self.section_worker(manifest),
            'highs': self.section_highs(),
            'lib-js': self.section_lib_js(libs),
        }
        main_scripts = self.section_main(manifest)
        # build info goes last into the hash-dependent part: every input has been read by now
        sections['main'] = '\n'.join([self.build_info()] + main_scripts)

        # one pass over the template, so text inside an inlined section (e.g. a CSS comment that
        # mentions a marker) is never substituted a second time
        html = re.sub(r'<!--INLINE:([\w.-]+)-->', lambda m: sections[m.group(1)], template)

        out_path = out_rel if os.path.isabs(out_rel) else self.path(out_rel)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        data = html.encode('utf-8')
        tmp = out_path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, out_path)

        if not self.quiet:
            print('Sections:')
            for label, size in self.sizes:
                print('  %10s B  %s' % ('{:,}'.format(size), label))
        shown = os.path.relpath(out_path, ROOT) if out_path.startswith(ROOT) else out_path
        print('Wrote %s: %s bytes (%.2f MB), build %s%s' % (
            shown, '{:,}'.format(len(data)), len(data) / 1048576.0, self.hasher.hexdigest()[:12],
            ', %d warning(s)' % len(self.warnings) if self.warnings else ''))
        return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description='Build prototype/supply-route-app.html from src/ and tools/manifest.json.')
    ap.add_argument('--strict', action='store_true', help='fail on missing non-optional files')
    ap.add_argument('--out', default=None,
                    help='output path, relative to the current directory (default: %s in the repo)' % DEFAULT_OUT)
    ap.add_argument('--exclude', action='append', default=[], metavar='GLOB',
                    help='leave out manifest files matching this glob (repeatable), e.g. "src/ui/planner/*"')
    ap.add_argument('--quiet', action='store_true', help='print only warnings and the final line')
    args = ap.parse_args(argv)
    # the default lives in the repo; a path the user types is relative to where they run the command
    out = os.path.abspath(args.out) if args.out else DEFAULT_OUT
    try:
        Build(strict=args.strict, excludes=args.exclude, quiet=args.quiet).run(out)
    except BuildError as e:
        print('BUILD FAILED: ' + str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
