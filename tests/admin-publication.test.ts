import {test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {createApp} from '../server/index.ts'

test('publication directe admin, brouillons, éditions et modération des contributeurs',async()=>{
 const runtime=createApp({authMode:'local',dbPath:':memory:'});runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');const address=runtime.server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api`
 function client(){let cookie='';return async(path:string,method='GET',body?:unknown)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;return {status:r.status,body:await r.json()}}}
 const admin=client(),contributor=client(),student=client();try{
  for(const [request,email] of [[admin,'admin'],[contributor,'contributeur'],[student,'eleve']] as const)await request('/auth/login','POST',{email:email+'@herbier.local',password:'Herbier2026!'})
  const chapter=(await admin('/chapters','POST',{name:'Publication directe'})).body;const input={chapterId:chapter.id,difficulty:'easy',prompt:'Quelle proposition est correcte pour ce test ?',options:['A','B','C','D'],correctAnswers:[0],image:null,status:'published'}
  for(const usage of ['solo','challenge']){
   const created=await admin('/questions','POST',{...input,usage});assert.equal(created.status,201);assert.equal(created.body.status,'published')
   const edited=await admin('/questions/'+created.body.id,'PUT',{...input,usage,prompt:'Quelle réponse convient après cette modification ?'});assert.equal(edited.status,200);assert.equal(edited.body.status,'published')
   const game=await student(usage==='solo'?'/games/solo':'/rooms','POST',{chapterIds:[chapter.id],count:1});assert.equal(game.status,201);assert.equal(game.body.totalQuestions,1)
  }
  const draft=await admin('/questions','POST',{...input,status:'draft'});assert.equal(draft.body.status,'draft')
  const denied=await contributor('/questions','POST',input);assert.equal(denied.status,403)
  const pending=await contributor('/questions','POST',{...input,status:'pending'});assert.equal(pending.body.status,'pending')
  assert.equal((await contributor('/questions/'+pending.body.id,'PUT',input)).status,403)
  assert.equal((await student('/questions','POST',input)).status,403)
  const before=(await admin('/questions')).body.length
  assert.equal((await admin('/questions/import','POST',{questions:[{...input,id:'import'}]})).status,201)
  const after=(await admin('/questions')).body;assert.equal(after.length,before+1);assert.equal(after.filter((q:{status:string})=>q.status==='pending').length,2)
 }finally{await runtime.close()}
})
