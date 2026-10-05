import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(process.getuid(), 1000);
assert.equal(Object.keys(process.env).some(k => /^RAILWAY_(?:(?:API|PROJECT)_)?TOKEN$/i.test(k)), false);
for (const p of ['/app','/app/dist/infrastructure/launcher.js','/app/node_modules','/app/railway-volume-maintenance.sh']) {
 assert.throws(() => fs.accessSync(p,fs.constants.W_OK));
}
for (const p of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
 let args;try { args=fs.readFileSync(`/proc/${p}/cmdline`,'utf8'); } catch { continue; }
 if(args.includes('/app/dist/infrastructure/launcher.js')) {
  assert.throws(() => fs.readFileSync(`/proc/${p}/environ`));
 }
}
fs.mkdirSync('/data/run',{recursive:true});
fs.symlinkSync('/app/dist/infrastructure/launcher.js','/data/run/root-target');
assert.throws(() => fs.writeFileSync('/data/run/root-target','tamper'));
if(process.env.CONTROL_INFRASTRUCTURE_ENABLED==='1') {
 assert.equal(fs.statSync('/data').uid,0);
 assert.equal(fs.statSync('/data').mode&0o1777,0o1777);
 assert.throws(()=>fs.readdirSync('/data/.infrastructure'));
 assert.throws(()=>fs.renameSync('/data/.infrastructure','/data/renamed-infrastructure'));
 process.send?.({channel:'control-application-ready'});
}
console.log('BOUNDARY_PASS uid=1000 credentials_absent protected_code=true protected_parent=true symlink_write_denied=true');
if(process.env.BOUNDARY_WAIT==='1')setTimeout(()=>{},60000);
