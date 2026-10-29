import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp } from '../server/index.ts'
import { chapterLabel, orderedChapters, selectedChapterIds, chapterCount, matchesSchoolYear } from '../shared/curriculum.ts'
import { filterLibraryQuestions } from '../src/services/question-library.ts'
import { importPayload, parseQuestionImport } from '../src/services/question-import.ts'
import type { Chapter, Question } from '../shared/types.ts'

const chapters: Chapter[] = [{ id:'root',name:'Cellules',shortName:'Cellules',description:'',color:'#648c5f',icon:'Leaf' },{id:'child',parentId:'root',name:'Membranes',shortName:'Membranes',description:'',color:'#648c5f',icon:'Leaf'}]
test('le choix d’un chapitre inclut ses sous-chapitres sans double compter ; les années communes sont incluses', () => {
  assert.deepEqual(selectedChapterIds(chapters,['root','child']),['root','child'])
  assert.deepEqual(selectedChapterIds(chapters,['child']),['child'])
  assert.equal(chapterCount(chapters,{root:2,child:3},'root'),5)
  assert.equal(chapterLabel(chapters,'child'),'Cellules → Membranes')
  assert.deepEqual(orderedChapters([...chapters].reverse()).map(c=>c.id),['root','child'])
  assert.equal(matchesSchoolYear(undefined,'BCPST1'),true)
  assert.equal(matchesSchoolYear('both','BCPST2'),true)
  assert.equal(matchesSchoolYear('BCPST1','BCPST2'),false)
})

test('les filtres et le JSON conservent les années ; le XML reçoit l’année choisie', () => {
  const base: Question = { id:'source',chapterId:'child',schoolYear:'BCPST1',difficulty:'easy',prompt:'Quelles propriétés décrivent une membrane ?',options:['A','B','C','D'],correctAnswers:[0],explanation:'Une correction suffisamment détaillée.',image:null,status:'draft',authorId:'admin',createdAt:'2026-10-29',updatedAt:'2026-10-29' }
  assert.equal(filterLibraryQuestions([base,{...base,id:'common',schoolYear:'both'}],{schoolYear:'BCPST2',chapterIds:['root','child']}).length,1)
  const plan=parseQuestionImport(JSON.stringify([base]),chapters)
  assert.equal(importPayload(plan,[1],{},'medium',chapters,'BCPST2')[0]!.schoolYear,'BCPST1')
  assert.match(parseQuestionImport(JSON.stringify([{...base,schoolYear:'admin'}]),chapters).rows[0]!.error!,/Année/)
})

test('années et sous-chapitres : droits, cycles, filtres serveur et conservation des parties', async t => {
  const runtime=createApp({authMode:'local',dbPath:':memory:'})
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening')
  const address=runtime.server.address();assert.ok(address&&typeof address!=='string')
  const base=`http://127.0.0.1:${address.port}/api`
  function client(){let cookie='';return async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})})
    cookie=response.headers.get('set-cookie')?.split(';')[0]??cookie
    return {status:response.status,body:await response.json()}
  }}
  const admin=client(),student=client(),contributor=client()
  try {
    for(const [request,email] of [[admin,'admin'],[student,'eleve'],[contributor,'contributeur']] as const) await request('/auth/login','POST',{email:email+'@herbier.local',password:'Herbier2026!'})
    const root=(await admin('/chapters','POST',{name:'Chapitre de test'})).body
    const child=(await admin('/chapters','POST',{name:'Sous-chapitre',parentId:root.id})).body
    assert.equal(child.parentId,root.id)
    await t.test('seul l’admin organise les sous-chapitres, sans cycles ni troisième niveau',async()=>{
      assert.equal((await student('/chapters','POST',{name:'Interdit',parentId:root.id})).status,403)
      assert.equal((await contributor('/chapters','POST',{name:'Interdit',parentId:root.id})).status,403)
      assert.equal((await admin('/chapters','POST',{name:'Petit enfant',parentId:child.id})).status,400)
      assert.equal((await admin(`/chapters/${root.id}`,'PATCH',{name:'Cycle',parentId:child.id})).status,400)
      assert.equal((await admin(`/chapters/${child.id}`,'PATCH',{name:'Cycle',parentId:child.id})).status,400)
      assert.equal((await admin('/chapters','POST',{name:'Absent',parentId:'missing'})).status,400)
      const renamed=await admin(`/chapters/${child.id}`,'PATCH',{name:'Sous-chapitre renommé'})
      assert.equal(renamed.body.parentId,root.id)
    })
    const input={chapterId:child.id,difficulty:'medium',prompt:'Une question de test sur les membranes ?',options:['A','B','C','D'],correctAnswers:[0],explanation:'La correction de cette notion est suffisamment détaillée.',image:null,status:'pending'}
    const q1=(await admin('/questions','POST',{...input,schoolYear:'BCPST1'})).body
    const q2=(await admin('/questions','POST',{...input,schoolYear:'BCPST2'})).body
    const common=(await admin('/questions','POST',input)).body
    const variant=(await admin('/questions','POST',{...input,usage:'challenge',sourceQuestionId:q1.id,schoolYear:'BCPST1'})).body
    for(const q of [q1,q2,common,variant]) assert.equal((await admin(`/questions/${q.id}/review`,'POST',{status:'published'})).status,200)
    await t.test('les années sont validées et les compteurs distinguent solo et défi',async()=>{
      assert.equal(common.schoolYear,'both')
      assert.equal((await admin('/questions','POST',{...input,schoolYear:'BCPST3'})).status,400)
      const bootstrap=(await student('/bootstrap')).body
      assert.equal(bootstrap.countsByYear.BCPST1[child.id],2)
      assert.equal(bootstrap.countsByYear.BCPST2[child.id],2)
      assert.equal(bootstrap.challengeCountsByYear.BCPST1[child.id],1)
      assert.equal(bootstrap.challengeCountsByYear.BCPST2[child.id],0)
      const questions=(await admin(`/questions?chapterId=${root.id}&schoolYear=BCPST2`)).body
      assert.deepEqual(new Set(questions.map((q:Question)=>q.id)),new Set([q2.id,common.id]))
    })
    await t.test('le serveur développe le parent et filtre les années sans exposer les corrections',async()=>{
      const game=(await student('/games/solo','POST',{chapterIds:[root.id,child.id],schoolYear:'BCPST1',count:30})).body
      assert.equal(game.totalQuestions,2)
      assert.equal(game.schoolYear,'BCPST1')
      assert.equal(game.question.chapterId,child.id)
      assert.ok(!('correctAnswers'in game.question))
      assert.deepEqual(new Set(runtime.games.read(game.id).questions.map(q=>q.id)),new Set([q1.id,common.id]))
      assert.equal((await student('/games/solo','POST',{schoolYear:'BCPST3'})).status,400)
      assert.equal((await student('/rooms','POST',{chapterIds:[root.id],schoolYear:'BCPST2'})).status,400)
      assert.equal((await student('/rooms','POST',{chapterIds:[root.id],schoolYear:'BCPST1'})).status,201)
      await admin(`/questions/${q1.id}`,'PUT',{...input,schoolYear:'BCPST2',status:'draft'})
      assert.deepEqual(new Set(runtime.games.read(game.id).questions.map(q=>q.id)),new Set([q1.id,common.id]))
      assert.equal(runtime.games.read(game.id).questions.find(q=>q.id===q1.id)!.schoolYear,'BCPST1')
      const legacy=await admin(`/questions/${q1.id}`,'PUT',{...input,status:'draft'})
      assert.equal(legacy.body.schoolYear,'BCPST2')
    })
    await t.test('l’export et l’import JSON gardent l’année de chaque question',async()=>{
      const exported=(await admin('/questions/export')).body.filter((q:Question)=>q.id===q2.id)
      const response=await admin('/questions/import','POST',{questions:exported})
      assert.equal(response.status,201)
      const rows=(await admin(`/questions?chapterId=${child.id}&schoolYear=BCPST2`)).body
      assert.ok(rows.some((q:Question)=>q.id!==q2.id&&q.schoolYear==='BCPST2'&&q.status==='pending'))
    })
  } finally {await runtime.close()}
})
