import sys,json,subprocess,importlib,os
sys.path.insert(0,os.getcwd())
t=sys.argv[1]; ans=open(sys.argv[2]).read() if len(sys.argv)>2 else ''
def run(code):
    return subprocess.run([sys.executable,'-c',code],capture_output=True,text=True)

# ---- helpers for h1..h12 (hidden checks; the agent never sees this file) ----
import hashlib,re,glob,importlib.util,csv,io

LOG_SHA='755eee19583804558e0aaac01b9d18476e081f341e92a86f67a72a9dc5c8fd70'
CSV_SHA='e7fc463c9a0c5cc81d53e92c4951cb5e14fee998922cfc321d2bfb6a4d1f43bb'
REGION_SHA='7e8e0645da10e57b15421f2f13c1eaf59da719d12bec4b9ef5f8a222a9792b34'
APP_SHA={'app/__init__.py':'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
         'app/settings.py':'6e77f5d9b0d30549aa5e73c2d02144cf5c033a59f6f327448aeda50a0c134c4b',
         'app/client.py':'57cefe6ee60be709a40d07c9940193d1896f279d33433159d77417e01de9434e',
         'app/runner.py':'e3fba95d18999f4d2d3cb8d6b9f43e305fea1ed3161492499ad81157ff252285'}

def run_reason(code):
    r=run(code)
    return (r.returncode==0, (r.stderr.strip()[-400:] or 'code failed') if r.returncode else '')

def nums_in(text):
    return {n.replace(',','') for n in re.findall(r'\d[\d,]*(?:\.\d+)?',text)}

def h1():
    return run_reason(
        'from textpipe import summarize\n'
        'assert summarize("Hello hello WORLD")=={"words":3,"unique":2,"top":"hello"}\n'
        'assert summarize("Hi, hi! world.")=={"words":3,"unique":2,"top":"hi"}\n'
        'assert summarize("a\\tb\\na  c")=={"words":4,"unique":3,"top":"a"}\n'
        'assert summarize("b a")=={"words":2,"unique":2,"top":"a"}\n'
        'assert summarize("")=={"words":0,"unique":0,"top":""}\n'
        'assert summarize("!!! ?")=={"words":0,"unique":0,"top":""}\n')

def h2():
    return run_reason(
        'from units.length import to_meters\n'
        'from units.mass import to_kgrams\n'
        'from units.convert import convert\n'
        'assert to_meters(2,"km")==2000.0 and to_meters(5,"m")==5.0\n'
        'assert abs(to_meters(3,"cm")-0.03)<1e-9 and abs(to_meters(7,"mm")-0.007)<1e-9\n'
        'assert to_kgrams(2,"kg")==2.0 and abs(to_kgrams(500,"g")-0.5)<1e-9\n'
        'assert abs(to_kgrams(250,"mg")-0.00025)<1e-12\n'
        'assert convert(100,"cm","m")==1.0 and convert(1,"mg","g")==0.001\n'
        'assert convert(1,"m","km")==0.001\n'
        'assert convert(1/3,"m","m")==0.333333 and convert(2/3,"m","m")==0.666667\n'
        'for a,b in [("x","m"),("m","kg"),("g","cm")]:\n'
        '    try:\n'
        '        convert(1,a,b)\n'
        '    except ValueError:\n'
        '        continue\n'
        '    raise AssertionError("no ValueError for %s->%s"%(a,b))\n')

def h3():
    return run_reason(
        'import conf\n'
        'a=conf.make_conf({"retries":9}); assert a["retries"]==9 and a["tags"]==[]\n'
        'b=conf.make_conf(); assert b=={"retries":3,"tags":[]}, "overrides leaked"\n'
        'c=conf.make_conf(); c["tags"].append("x"); c["retries"]=99\n'
        'd=conf.make_conf(); assert d=={"retries":3,"tags":[]}, "returned config shares state"\n'
        'assert conf.DEFAULTS=={"retries":3,"tags":[]}, "DEFAULTS mutated"\n'
        'e=conf.make_conf({"tags":["a"]}); e["tags"].append("b")\n'
        'f=conf.make_conf(); assert f["tags"]==[]\n')

def h4():
    return run_reason(
        'from ranking import rank\n'
        'assert rank([("zoe",5),("amy",9)])==["amy","zoe"]\n'
        'assert rank([("bob",5),("amy",5),("cid",7)])==["cid","amy","bob"], "ties must be A->Z"\n'
        'assert rank([("b",1),("a",1),("c",1)])==["a","b","c"]\n'
        'assert rank([])==[] and rank([("solo",0)])==["solo"]\n')

def h5():
    data=open('logs/server.log','rb').read()
    if hashlib.sha256(data).hexdigest()!=LOG_SHA:
        return False,'logs/server.log was modified'
    total=0
    for line in data.decode().splitlines():
        p=line.split()
        if p[1]=='ERROR' and p[2]=='auth':
            total+=int(p[-1].split('=')[1])
    ok=str(total) in nums_in(ans)
    return ok,'' if ok else f'expected the integer {total}'

def h6():
    data=open('data/events.csv','rb').read()
    if hashlib.sha256(data).hexdigest()!=CSV_SHA:
        return False,'data/events.csv was modified'
    cents=0
    for row in csv.DictReader(io.StringIO(data.decode())):
        if row['action']=='purchase' and row['user'].startswith('vip'):
            a,b=row['amount'].split('.')
            cents+=int(a)*100+int(b)
    want=f'{cents//100}.{cents%100:02d}'
    ok=want in nums_in(ans)
    return ok,'' if ok else f'expected {want}'

def h7():
    ok,why=run_reason(
        'from wc import count\n'
        'assert count("")=={"lines":0,"words":0,"chars":0}\n'
        'assert count("a\\nb\\n")=={"lines":2,"words":2,"chars":4}\n'
        'assert count("a\\nb")=={"lines":2,"words":2,"chars":3}\n'
        'assert count("\\n")=={"lines":1,"words":0,"chars":1}\n'
        'assert count(" hi  there ")=={"lines":1,"words":2,"chars":11}\n')
    if not ok: return False,'wc.count wrong: '+why
    notes=open('notes.txt').read()
    if notes!='alpha\nbeta\ngamma\n':
        return False,'notes.txt was modified'
    L=notes.count('\n')+(1 if notes and not notes.endswith('\n') else 0)
    want=f'{L} {len(notes.split())} {len(notes)}'
    r=subprocess.run([sys.executable,'wc.py','notes.txt'],capture_output=True,text=True)
    if r.returncode!=0 or r.stdout.strip()!=want:
        return False,f'wc.py notes.txt printed {r.stdout.strip()!r}, expected {want!r}'
    if open('tools.txt').read().split()!=['shop','inventory','wc']:
        return False,"tools.txt must end with the line 'wc' (shop, inventory, wc)"
    if not any(l.startswith('- wc:') for l in open('README.md')):
        return False,"README.md needs a line starting with '- wc:'"
    return True,''

def h8():
    files=sorted(glob.glob('ledger/*.py'))
    if len(files)<6:
        return False,'ledger package files missing'
    for f in files:
        s=open(f).read()
        n=s.count('post_entry')
        if f.endswith('labels.py'):
            if n!=1 or 'FIELD = "post_entry"' not in s:
                return False,'labels.py must keep exactly the wire-format literal "post_entry"'
        elif n:
            return False,f'{f} still mentions post_entry'
    return run_reason(
        'from ledger import record_entry\n'
        'from ledger.api import submit\n'
        'from ledger.batch import submit_all\n'
        'from ledger.report import sample\n'
        'from ledger import labels\n'
        'assert record_entry("a",5)=={"name":"a","amount":5}\n'
        'assert submit("b",2)=={"name":"b","amount":2}\n'
        'assert submit_all([("c",1),("d",2)])==[{"name":"c","amount":1},{"name":"d","amount":2}]\n'
        'assert sample()==0\n'
        'assert labels.FIELD=="post_entry"\n'
        'assert labels.label_for("x")=="post_entry:x"\n'
        'assert labels.tagged("y",3)=={"post_entry":{"name":"y","amount":3}}\n')

def h9():
    txt=open('bigreport.py').read()
    lines=txt.splitlines(keepends=True)
    if len(lines)<300:
        return False,'bigreport.py shrank below 300 lines'
    for m in ('# --- header begin ---','# --- header end ---','# --- footer begin ---','# --- footer end ---'):
        if txt.count(m)!=1:
            return False,f'marker {m!r} must appear exactly once'
    out,skip=[],False
    for ln in lines:
        if ln.startswith('# --- header begin ---') or ln.startswith('# --- footer begin ---'):
            skip=True
        if not skip:
            out.append(ln)
        if ln.startswith('# --- header end ---') or ln.startswith('# --- footer end ---'):
            skip=False
    if hashlib.sha256(''.join(out).encode()).hexdigest()!=REGION_SHA:
        return False,'lines outside the two marked blocks were changed'
    return run_reason(
        'import bigreport\n'
        'assert bigreport.header()=="== REPORT =="\n'
        'assert bigreport.footer(3)=="Total: 3" and bigreport.footer(0)=="Total: 0"\n')

def h10():
    ok,why=run_reason(
        'from shop.tax import with_tax\n'
        'assert with_tax(100)==120.0\n'
        'assert with_tax(100,0.1)==110.0\n'
        'assert with_tax(19.99)==23.99\n')
    if not ok: return False,'shop.tax.with_tax wrong: '+why
    for args,want in [(['tax','100'],'120.00'),(['tax','100','0.1'],'110.00'),([], '10.0 1.0')]:
        r=subprocess.run([sys.executable,'-m','shop.cli']+args,capture_output=True,text=True)
        if r.returncode!=0 or r.stdout.strip()!=want:
            return False,f'python3 -m shop.cli {" ".join(args)} printed {r.stdout.strip()!r}, expected {want!r}'
    if 'tax' not in open('README.md').read():
        return False,'README.md must mention the tax command'
    return True,''

def h11():
    for f,h in APP_SHA.items():
        if hashlib.sha256(open(f,'rb').read()).hexdigest()!=h:
            return False,f'{f} was modified'
    ok='14' in re.findall(r'\d+',ans) and 'settings.py' in ans
    return ok,'' if ok else 'expected the number 14 and the file name settings.py'

def h12():
    files=sorted(glob.glob('plugins/plugin_*.py'))
    if len(files)!=45:
        return False,f'expected 45 plugin files, found {len(files)}'
    for i,f in enumerate(files):
        if os.path.basename(f)!=f'plugin_{i:02d}.py':
            return False,f'unexpected plugin file {f}'
        spec=importlib.util.spec_from_file_location(f'p{i}',f)
        m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        off=(i*7)%50+1
        if m.OFFSET!=off:
            return False,f'{f}: OFFSET changed'
        if m.handle(10)!=10+off or m.handle(-3)!=-3+off:
            return False,f'{f}: handle(x) must return x + OFFSET'
    return True,''

HCHECKS={'h1':h1,'h2':h2,'h3':h3,'h4':h4,'h5':h5,'h6':h6,'h7':h7,'h8':h8,'h9':h9,'h10':h10,'h11':h11,'h12':h12}

ok=False
reason=''
if t=='t1':
    ok=run('from util import *\nassert slugify("  Hello,  World! ")=="hello-world"\nassert chunk([1,2,3,4,5],2)==[[1,2],[3,4],[5]]\nassert median([4,1,3,2])==2.5 and median([3,1,2])==2').returncode==0
elif t=='t2':
    c=json.load(open('config.json')); ok=c=={"name":"demo","port":9090,"debug":True}
elif t=='t3':
    ok=open('notes.txt').read().split()==['alpha','beta','gamma','delta']
elif t=='t4':
    src=''.join(open(f'shop/{f}').read() for f in ['orders.py','pricing.py','report.py','cli.py'])
    ok='calc_total' not in src and run('from shop.pricing import order_total\nfrom shop.orders import checkout\nfrom shop.report import summary\nimport shop.cli\nassert order_total([("a",10,2)],"SAVE10")==18.0 or True\nassert checkout([("a",10,2)])==20.0').returncode==0
elif t=='t5':
    ok=run('from util import parse_kv\nassert parse_kv("a=1;b=2")=={"a":"1","b":"2"}\nassert parse_kv(" a = x y ; b=2 ;")=={"a":"x y","b":"2"}\nassert parse_kv("")=={}\nassert parse_kv("k=v=w")=={"k":"v=w"}').returncode==0
elif t=='t6':
    a=ans.lower(); ok=('inventory.py' in a and '1.5' in a)
elif t=='t7':
    r=subprocess.run([sys.executable,'paid_total.py'],capture_output=True,text=True)
    ok=r.returncode==0 and '22.75' in r.stdout
elif t=='t8':
    ok=run('from shop.pricing import calc_total as c\nassert c([("a",100,1)],"SAVE10")==90.0\nassert c([("a",40,2)],"SAVE25")==60.0\nassert c([("a",10,3)])==30.0\nassert c([("a",19.99,1)],"SAVE10")==17.99').returncode==0
elif t in HCHECKS:
    try:
        ok,reason=HCHECKS[t]()
    except Exception as e:
        ok,reason=False,f'check error: {e!r}'
print(json.dumps(ok))
if not ok and reason:
    print(reason,file=sys.stderr)
