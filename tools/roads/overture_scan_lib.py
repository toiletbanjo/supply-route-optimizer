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
