# Fetch only Taiwan row groups / needed columns of Overture segments; keep major road classes.
import json, struct, collections, concurrent.futures as cf, time
import pyarrow.parquet as pq, pyarrow.compute as pc
from overture_scan_lib import RangeFile, BASE
H=json.load(open('overture_hits.json'))
X0,Y0,X1,Y1=119.9,21.8,122.1,25.4
KEEP={'motorway','trunk','primary','secondary','tertiary'}
COLS=['id','subtype','class','subclass','names.primary','routes','connectors','geometry','bbox','access_restrictions','road_flags']
def wkb_line(b):
    # minimal WKB LineString / MultiLineString decoder
    def rd(off):
        bo='<' if b[off]==1 else '>'; t=struct.unpack_from(bo+'I',b,off+1)[0]; off+=5
        if t==2:
            n=struct.unpack_from(bo+'I',b,off)[0]; off+=4
            pts=struct.unpack_from(bo+'%dd'%(2*n),b,off); off+=16*n
            return [[(pts[2*i],pts[2*i+1]) for i in range(n)]],off
        if t==5:
            n=struct.unpack_from(bo+'I',b,off)[0]; off+=4; out=[]
            for _ in range(n):
                l,off=rd(off); out+=l
            return out,off
        raise ValueError('geom type %d'%t)
    return rd(0)[0]
def job(args):
    key,rg=args
    f=RangeFile(BASE+key,H['sizes'][H['keys'].index(key)]); pf=pq.ParquetFile(f)
    t=pf.read_row_group(rg,columns=COLS)
    bb=t.column('bbox').combine_chunks()
    xmin=pc.struct_field(bb,'xmin'); xmax=pc.struct_field(bb,'xmax'); ymin=pc.struct_field(bb,'ymin'); ymax=pc.struct_field(bb,'ymax')
    m=pc.and_(pc.and_(pc.less_equal(xmin,X1),pc.greater_equal(xmax,X0)),pc.and_(pc.less_equal(ymin,Y1),pc.greater_equal(ymax,Y0)))
    m=pc.and_(m,pc.equal(t.column('subtype'),'road'))
    m=pc.and_(m,pc.is_in(t.column('class'),value_set=__import__('pyarrow').array(sorted(KEEP))))
    t=t.filter(m)
    rows=[]
    for r in t.to_pylist():
        rows.append({'id':r['id'],'class':r['class'],'subclass':r['subclass'],'name':(r['names'] or {}).get('primary') if isinstance(r.get('names'),dict) else r.get('names.primary'),
                     'refs':sorted({x['ref'] for x in (r['routes'] or []) if x.get('ref')}),
                     'conn':[(c['connector_id'],c['at']) for c in (r['connectors'] or [])],
                     'geom':wkb_line(r['geometry']),'acc':r['access_restrictions'],'flags':r['road_flags']})
    return key,rg,len(rows),f.bytes,rows
tasks=[(k,h[0]) for k,v in H['hits'].items() for h in v]
allrows=[]; tot=0; t0=time.time()
with cf.ThreadPoolExecutor(12) as ex:
    for key,rg,n,nb,rows in ex.map(job,tasks):
        allrows+=rows; tot+=nb
print('rowgroups',len(tasks),'kept',len(allrows),'MB fetched',round(tot/1e6,1),'s',round(time.time()-t0,1))
json.dump(allrows,open('overture_tw_major.json','w'))
print(collections.Counter(r['class'] for r in allrows))
