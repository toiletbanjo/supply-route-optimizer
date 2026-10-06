# Scan Overture transportation/segment parquet footers via HTTP range requests,
# find row groups whose bbox stats intersect Taiwan. No downloads of full files.
import requests, re, io, json, sys, concurrent.futures as cf
import pyarrow.parquet as pq
BASE='https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/'
REL='release/2026-09-23.1/theme=transportation/type=segment/'
S=requests.Session()
class RangeFile(io.RawIOBase):
    def __init__(s,url,size): s.url=url; s.size=size; s.pos=0; s.n=0; s.bytes=0
    def seekable(s): return True
    def readable(s): return True
    def tell(s): return s.pos
    def seek(s,off,wh=0):
        s.pos = off if wh==0 else (s.pos+off if wh==1 else s.size+off); return s.pos
    def read(s,n=-1):
        if n is None or n<0: n=s.size-s.pos
        if n==0 or s.pos>=s.size: return b''
        end=min(s.size,s.pos+n)-1
        r=S.get(s.url,headers={'Range':f'bytes={s.pos}-{end}'},timeout=120); r.raise_for_status()
        s.n+=1; s.bytes+=len(r.content); s.pos+=len(r.content); return r.content
    def readinto(s,b):
        d=s.read(len(b)); b[:len(d)]=d; return len(d)
t=S.get(BASE,params={'list-type':'2','prefix':REL}).text
keys=re.findall(r'<Key>([^<]+)</Key>',t); sizes=list(map(int,re.findall(r'<Size>([^<]+)</Size>',t)))
X0,Y0,X1,Y1=119.9,21.8,122.1,25.4
def scan(i):
    f=RangeFile(BASE+keys[i],sizes[i]); pf=pq.ParquetFile(f)
    md=pf.metadata; names=[md.schema.column(j).path for j in range(md.num_columns)]
    idx={n:names.index(n) for n in ('bbox.xmin','bbox.xmax','bbox.ymin','bbox.ymax')}
    hits=[]
    for rg in range(md.num_row_groups):
        r=md.row_group(rg); st={k:r.column(j).statistics for k,j in idx.items()}
        xmin=st['bbox.xmin'].min; xmax=st['bbox.xmax'].max; ymin=st['bbox.ymin'].min; ymax=st['bbox.ymax'].max
        if xmin<=X1 and xmax>=X0 and ymin<=Y1 and ymax>=Y0: hits.append((rg,r.num_rows,r.total_byte_size))
    return i,hits,md.num_row_groups,names
res={}
with cf.ThreadPoolExecutor(16) as ex:
    for i,hits,nrg,names in ex.map(scan,range(len(keys))):
        if hits: res[keys[i]]=hits; print(i,nrg,hits[:5],len(hits),flush=True)
json.dump({'keys':keys,'sizes':sizes,'hits':res,'columns':names},open('overture_hits.json','w'))
print('files with hits',len(res),'rowgroups',sum(len(v) for v in res.values()),'rows',sum(h[1] for v in res.values() for h in v))
print(names)
