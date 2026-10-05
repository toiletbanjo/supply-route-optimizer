// Creates the shared SRO namespace. Must load before every other script.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.version = '0.1.0';
  SRO.core = SRO.core || {};
  SRO.data = SRO.data || {};
  SRO.solver = SRO.solver || {};
  SRO.ui = SRO.ui || {};
  SRO.lib = SRO.lib || {};
})(typeof self !== 'undefined' ? self : globalThis);
