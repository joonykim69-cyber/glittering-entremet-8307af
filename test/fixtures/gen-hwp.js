const zlib=require('zlib'), fs=require('fs'), cp=require('child_process');
// cfb는 일회성 도구다: npm i --no-save cfb
const CFB=require('cfb');
const OUT=__dirname;
function paraTextRecord(str){
  const body=Buffer.from(str.split('').map(c=>c.charCodeAt(0)).reduce((a,c)=>{a.push(c&0xff,(c>>8)&0xff);return a;},[]));
  const tag=67,level=0;
  if(body.length<0xfff){const h=Buffer.alloc(4);h.writeUInt32LE((((tag&0x3ff)|((level&0x3ff)<<10)|((body.length&0xfff)<<20))>>>0));return Buffer.concat([h,body]);}
  const h=Buffer.alloc(8);h.writeUInt32LE((((tag&0x3ff)|((level&0x3ff)<<10)|(0xfff<<20))>>>0),0);h.writeUInt32LE(body.length,4);
  return Buffer.concat([h,body]);
}
function otherRecord(tag,len){const body=Buffer.alloc(len,0x41);const h=Buffer.alloc(4);h.writeUInt32LE((((tag&0x3ff)|((len&0xfff)<<20))>>>0));return Buffer.concat([h,body]);}
function fileHeader({compressed=true,encrypted=false}={}){const b=Buffer.alloc(256);b.write('HWP Document File',0,'latin1');b.writeUInt32LE(0x05000000,32);b.writeUInt32LE((compressed?1:0)|(encrypted?2:0),36);return b;}
function buildHwp(sections,opts){const o=Object.assign({compressed:true},opts);const c=CFB.utils.cfb_new({root:'Root Entry'});
  CFB.utils.cfb_add(c,'/FileHeader',fileHeader(o));
  sections.forEach((s,i)=>CFB.utils.cfb_add(c,`/BodyText/Section${i}`,o.compressed?zlib.deflateRawSync(s):s));
  return Buffer.from(CFB.write(c,{type:'buffer'}));}
const P1='공매재산명세서',P2='임차인: 홍길동, 보증금 5,000만원 (인수 조건)',P3='명도책임: 매수인';
const sec0=Buffer.concat([otherRecord(66,8),paraTextRecord(P1),paraTextRecord(P2),otherRecord(70,4)]);
const sec1=Buffer.concat([paraTextRecord(P3)]);
fs.writeFileSync(`${OUT}/sample-compressed.hwp`,buildHwp([sec0,sec1],{compressed:true}));
fs.writeFileSync(`${OUT}/sample-uncompressed.hwp`,buildHwp([sec0],{compressed:false}));
fs.writeFileSync(`${OUT}/sample-encrypted.hwp`,buildHwp([sec0],{compressed:true,encrypted:true}));
fs.writeFileSync(`${OUT}/sample-longrecord.hwp`,buildHwp([paraTextRecord('가'.repeat(3000))],{compressed:true}));
// hwpx via system zip (제3자 구현)
cp.execSync(`rm -rf /tmp/hx && mkdir -p /tmp/hx/Contents`);
const xml0=`<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hp="x"><hp:p><hp:run><hp:t>${P1}</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>${P2.replace(/&/g,'&amp;')}</hp:t></hp:run></hp:p></hs:sec>`;
const xml1=`<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hp="x"><hp:p><hp:run><hp:t>${P3}</hp:t></hp:run></hp:p></hs:sec>`;
fs.writeFileSync('/tmp/hx/Contents/section0.xml',xml0);
fs.writeFileSync('/tmp/hx/Contents/section1.xml',xml1);
fs.writeFileSync('/tmp/hx/mimetype','application/hwp+zip');
cp.execSync(`cd /tmp/hx && zip -q -r ${OUT}/sample.hwpx .`);
console.log('generated');
