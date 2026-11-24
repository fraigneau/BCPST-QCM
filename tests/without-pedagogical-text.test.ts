import {test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDatabase} from '../server/database.ts'
import {createApp} from '../server/index.ts'

test('les anciens textes SQLite disparaissent sans modifier choix, points ou snapshots',()=>{
 const directory=mkdtempSync(join(tmpdir(),'qcm-plain-'));const path=join(directory,'test.sqlite');let db=openDatabase(path)
 try{
  const row=db.prepare('select id,body from questions limit 1').get()!;const question=JSON.parse(String(row.body));question.explanation='Ancien texte pédagogique.'
  db.prepare('update questions set body=? where id=?').run(JSON.stringify(question),String(row.id))
  db.prepare('insert into games(id,body,status,updated_at) values(?,?,?,?)').run('plain-game',JSON.stringify({questions:[question],status:'finished'}),'finished',1)
  db.prepare('insert into answers(game_id,user_id,question_index,question_id,chapter_id,prompt,correct,points,body,created_at) values(?,?,?,?,?,?,?,?,?,?)').run('plain-game','demo-student',0,question.id,question.chapterId,question.prompt,1,100,JSON.stringify({selected:[0],correctAnswers:[0],points:100,explanation:'Ancien texte.'}),new Date().toISOString())
  db.prepare("delete from metadata where key='without-pedagogical-text'").run();db.close();db=openDatabase(path)
  const saved=JSON.parse(String(db.prepare('select body from questions where id=?').get(question.id)!.body));delete question.explanation;assert.deepEqual(saved,question)
  const game=JSON.parse(String(db.prepare('select body from games where id=?').get('plain-game')!.body));assert.deepEqual(game.questions,[question]);assert.equal(game.status,'finished')
  const answer=JSON.parse(String(db.prepare('select body from answers where game_id=?').get('plain-game')!.body));assert.deepEqual(answer,{selected:[0],correctAnswers:[0],points:100})
 }finally{db.close();rmSync(directory,{recursive:true,force:true})}
})

test('solo et QCS sans source se créent, s’exportent et se jouent sans texte pédagogique',async()=>{
 const runtime=createApp({authMode:'local',dbPath:':memory:'});runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');const addr=runtime.server.address();assert.ok(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}/api`;let cookie=''
 const request=async(path:string,method='GET',body?:unknown)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;return {status:r.status,body:await r.json()}}
 try{
  await request('/auth/login','POST',{email:'admin@herbier.local',password:'Herbier2026!'})
  const chapter=(await request('/chapters','POST',{name:'Sans texte'})).body
  const input={chapterId:chapter.id,difficulty:'easy',prompt:'Quelle proposition convient pour ce test ?',options:['A','B','C','D'],correctAnswers:[0],image:null,status:'pending'}
  for(const usage of ['solo','challenge']){
   const created=await request('/questions','POST',{...input,usage,explanation:'Ancien champ ignoré.'});assert.equal(created.status,201);assert.ok(!('explanation' in created.body));assert.equal(created.body.sourceQuestionId,null)
   assert.equal((await request(`/questions/${created.body.id}/review`,'POST',{status:'published'})).status,200)
   const game=(await request(usage==='solo'?'/games/solo':'/rooms','POST',{chapterIds:[chapter.id],count:1})).body
   if(usage==='challenge'){assert.equal(game.totalQuestions,1);continue}
   const answered=await request(`/games/${game.id}/answer`,'POST',{questionId:created.body.id,selected:[0]});assert.equal(answered.status,200);assert.equal(answered.body.result.correct,true);assert.ok(answered.body.result.points>=100);assert.ok(!('explanation' in answered.body.result))
  }
  const exported=(await request('/questions/export')).body;assert.ok(exported.every((q:Record<string,unknown>)=>!('explanation' in q)))
 }finally{await runtime.close()}
})
