# Read-only metadata projection of WebKit v15 structured-clone records.
# Format reference: WebKit Source/JavaScriptCore/runtime/StructuredCloneTags.h.
import pathlib,sqlite3,json,struct
class Decoder:
 def __init__(self,b):self.b=bytes(b);self.i=0;self.strings=[];self.objects=[]
 def take(self,n):
  assert 0<=n<=len(self.b)-self.i
  r=self.b[self.i:self.i+n];self.i+=n;return r
 def n(self,f):return struct.unpack('<'+f,self.take(struct.calcsize('<'+f)))[0]
 def index(self,pool):return self.n('B' if len(pool)<=255 else 'H' if len(pool)<=65535 else 'I')
 def string(self):
  n=self.n('I')
  if n==0xffffffff:return None
  if n==0xfffffffe:return self.strings[self.index(self.strings)]
  s=self.take(n&0x7fffffff if n&0x80000000 else n*2).decode('latin1' if n&0x80000000 else 'utf-16-le');self.strings.append(s);return s
 def value(self):
  t=self.n('B')
  if t in (3,4):return None
  if t==5:return self.n('i')
  if t==6:return 0
  if t==7:return 1
  if t==8:return False
  if t==9:return True
  if t in (10,11):return self.n('d')
  if t==16:return self.string()
  if t==17:return ''
  if t==19:return self.objects[self.index(self.objects)]
  if t==2:
   r={};self.objects.append(r)
   while True:
    k=self.string()
    if k is None:return r
    r[k]=self.value()
  if t==1:
   length=self.n('I');assert length<1000000
   r=[None]*length;self.objects.append(r)
   while True:
    k=self.n('I')
    if k==0xffffffff:break
    assert k<length;r[k]=self.value()
   tag=self.n('I')
   if tag==0xffffffff:return r
   assert tag==0xfffffffd,('array-section',self.i,tag)
   while True:
    k=self.string()
    if k is None:return r
    raise ValueError('Non-index property')
  raise ValueError('Unsupported tag '+str(t))
 def decode(self):
  assert self.n('I')==15
  r=self.value();assert self.i==len(self.b),(self.i,len(self.b));return r

def contains(b,s):return s.encode() in b or s.encode('utf-16-le') in b
if __name__=='__main__':
 for p in (pathlib.Path.home()/'Library/WebKit/md.thomas.orb').rglob('IndexedDB.sqlite3'):
  c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
  for key,v in c.execute('select cast(key as blob),value from Records'):
   key=bytes(key)
   if not contains(key,'followups'):continue
   kind='recovery' if contains(key,'recovered') else 'wake-fences' if contains(key,'wake-stops') else 'seen' if contains(key,':seen') else 'queue'
   try:
    data=Decoder(v).decode()
    rows=data if isinstance(data,list) else [data]
    safe=[{k:r[k] for k in ['id','mission','state','interrupted','autoResumed','resumes','cut','retryAfter','waiting','delegated','scheduled','claimedAt','userSynced','heldAt','resultStatus'] if k in r} for r in rows if isinstance(r,dict)]
    print(json.dumps({'kind':kind,'decoded':True,'count':len(rows),'metadata':safe}))
   except Exception as e:print(json.dumps({'kind':kind,'decoded':False,'error_type':type(e).__name__,'error':str(e) if isinstance(e,AssertionError) else ''}))
