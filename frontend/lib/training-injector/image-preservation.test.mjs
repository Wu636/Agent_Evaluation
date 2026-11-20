import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveImagePreservation} from './image-preservation.ts';
test('preserves full safe cover DTO and independent background theme by exact stage name',()=>{
 const cover={fileId:'bg',fileUrl:'https://mock.invalid/bg',originFileName:'原图.png',nested:{width:100}};
 const result=resolveImagePreservation('preserve',[{stepName:'阶段一'},{stepName:'new'}],[{stepDetailDTO:{stepName:'阶段一',scriptStepCover:cover,backgroundTheme:'theme-old'}}],{fileId:'cover',fileUrl:'https://mock.invalid/cover'});
 assert.deepEqual(result.backgrounds.get('阶段一'),{cover,theme:'theme-old',present:true});assert.equal(result.backgrounds.get('new').present,false);assert.equal(result.cover.fileId,'cover');
 cover.nested.width=200;assert.equal(result.backgrounds.get('阶段一').cover.nested.width,100);
});
test('duplicate names and malformed existing references block before mutation',()=>{
 assert.throws(()=>resolveImagePreservation('missing',[{stepName:'x'},{stepName:'x'}],[],null),/ambiguous/);
 assert.throws(()=>resolveImagePreservation('preserve',[{stepName:'x'}],[{stepName:'x'},{stepName:'x'}],null),/ambiguous/);
 assert.throws(()=>resolveImagePreservation('missing',[{stepName:'x'}],[{stepName:'x',scriptStepCover:{fileId:23}}],null),/fileId/);
 assert.throws(()=>resolveImagePreservation('missing',[{stepName:'x'}],[{stepName:'x',scriptStepCover:{cookie:'secret'}}],null),/metadata/);
 for(const reference of [{fileUrl:'https://mock.invalid/old'},{coverUrl:'https://mock.invalid/old'}]){
 assert.throws(()=>resolveImagePreservation('preserve',[{stepName:'x'}],[{stepName:'x',scriptStepCover:reference}],null),/lacks fileId/);
 assert.throws(()=>resolveImagePreservation('missing',[],[],reference),/lacks fileId/);
 }
 assert.equal(resolveImagePreservation('missing',[],[],{fileId:null,fileUrl:null}).cover,null);
});
test('regenerate does not reuse existing references; oral nested theme supported',()=>{
 assert.equal(resolveImagePreservation('regenerate',[{stepName:'x'}],[],{fileId:'old'}).cover,null);
 assert.equal(resolveImagePreservation('missing',[{stepName:'x'}],[{stepName:'x',stepExtProperty:{backgroundTheme:'white'}}],null).backgrounds.get('x').theme,'white');
});
