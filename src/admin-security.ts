import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {Request,Response,NextFunction} from 'express';

const digest=(value:string)=>createHash('sha256').update(value).digest();
export const escapeHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function createAdminSecurity(password:string,serverUrl:string,clock=()=>Date.now()) {
  if(!password)throw new Error('Admin password is required');
  const expected=digest(password),origin=new URL(serverUrl).origin;
  const cookieName='__Host-office-gmail-admin';
  const sessions=new Map<string,number>();
  const states=new Map<string,{session:string;expires:number}>();
  function prune(){for(const [k,v] of sessions)if(v<=clock())sessions.delete(k);for(const [k,v] of states)if(v.expires<=clock()||!sessions.has(v.session))states.delete(k);}
  function cookie(req:Request){const matches=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));return matches.length===1?matches[0].slice(cookieName.length+1):'';}
  function session(req:Request){prune();const value=cookie(req);return /^[a-f0-9]{64}$/.test(value)&&sessions.has(digest(value).toString('hex'))?digest(value).toString('hex'):null;}
  function headers(res:Response){res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});}
  function matches(value:unknown){return typeof value==='string'&&timingSafeEqual(digest(value),expected);}
  function requireAdmin(req:Request,res:Response,next:NextFunction){
    headers(res);
    if(req.query.key!==undefined){res.status(400).send('Password URLs are disabled. Open /setup and sign in.');return;}
    const header=matches(req.headers['x-admin-key']);
    if(!header&&!session(req)){res.status(401).send('<html><body><h2>Admin Login</h2><form method="POST" action="/admin/login"><input type="password" name="password" autocomplete="current-password" required/><button type="submit">Login</button></form></body></html>');return;}
    if(req.method!=='GET'&&req.method!=='HEAD'&&(!header||req.headers.origin)&&req.headers.origin!==origin){res.status(403).send('Same-origin admin request required');return;}
    next();
  }
  function login(req:Request,res:Response){
    headers(res);prune();
    if(req.headers.origin!==origin){res.status(403).send('Same-origin admin login required');return;}
    if(!matches(req.body?.password)){res.status(401).send('Admin login failed');return;}
    if(sessions.size>=100){res.status(503).send('Admin session capacity reached');return;}
    const value=randomBytes(32).toString('hex');sessions.set(digest(value).toString('hex'),clock()+30*60_000);
    res.set('Set-Cookie',`${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800`);
    res.redirect('/setup');
  }
  function issueState(req:Request){
    const binding=session(req);if(!binding)throw new Error('Browser admin session required');
    if(states.size>=100)throw new Error('OAuth state capacity reached');
    const state=randomBytes(32).toString('hex');states.set(digest(state).toString('hex'),{session:binding,expires:clock()+5*60_000});return state;
  }
  function consumeState(req:Request,state:unknown){
    const binding=session(req);if(!binding||typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state))return false;
    const key=digest(state).toString('hex'),pending=states.get(key);
    if(!pending||pending.expires<=clock()||pending.session!==binding)return false;
    states.delete(key);return true;
  }
  return {requireAdmin,login,issueState,consumeState};
}
