import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
interface SshModule {
  describeTailnetSshTarget(input: Record<string, unknown>): Promise<{ hostname: string; dnsName?: string; ips: string[]; os?: string; username: string; port: number; authentication: string; passwordRequired: false }>;
  checkTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  execTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  transferTailnetSshFile(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
async function service(): Promise<SshModule> { return import(pathToFileURL(path.join(DIST_ROOT, "app/services/ssh-service.js")).href) as Promise<SshModule>; }
function output(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }
function clean(value?: string): string | undefined { const v=value?.trim(); return v ? v : undefined; }
function inside(root: string,target: string): boolean { const relative=path.relative(root,target); return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative)); }
async function uploadSource(worktree:string,raw:string):Promise<string>{
  if(!raw.trim()||path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root=await fs.realpath(path.resolve(worktree)).catch(()=>path.resolve(worktree));
  const actual=await fs.realpath(path.resolve(root,raw));
  if(!inside(root,actual)) throw new Error("Upload source escapes the current worktree.");
  if(!(await fs.stat(actual)).isFile()) throw new Error("Upload source must be a regular file.");
  return actual;
}
async function downloadDestination(worktree:string,raw:string,overwrite:boolean):Promise<string>{
  if(!raw.trim()||path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root=await fs.realpath(path.resolve(worktree)).catch(()=>path.resolve(worktree));
  const target=path.resolve(root,raw);
  if(!inside(root,target)) throw new Error("Download destination escapes the current worktree.");
  let cursor=path.dirname(target);
  while(true){try{const actual=await fs.realpath(cursor);if(!inside(root,actual))throw new Error("Download destination escapes through a symlink.");break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const parent=path.dirname(cursor);if(parent===cursor)throw new Error("Could not resolve a safe download destination.");cursor=parent;}}
  if(!overwrite&&await fs.access(target).then(()=>true).catch(()=>false)) throw new Error("Download destination already exists. Pass overwrite=true to replace it.");
  return target;
}
function permissionAction(action:string):string{
  switch(action){case"check":return"Check SSH access";case"debug":return"Debug SSH connection";case"exec":return"Execute remote command";case"upload":return"Upload file";case"download":return"Download file";default:return action;}
}
export default tool({
  description:"Passwordless SSH to online Tailnet peers tagged tag:ssh. Uses native Tailscale SSH when available; otherwise uses the bot managed Ed25519 key over Tailscale. Direct public-internet SSH and password authentication are unsupported.",
  args:{
    action:tool.schema.enum(["check","debug","exec","upload","download"]).describe("SSH operation."),
    target:tool.schema.string().describe("Tailnet hostname, MagicDNS name, or Tailscale IP of a visible tag:ssh peer."),
    user:tool.schema.string().describe("Remote OS username."),
    port:tool.schema.number().optional().describe("SSH port, default 22. Non-22 ports use managed-key SSH over Tailscale."),
    timeoutMs:tool.schema.number().optional().describe("Per-attempt timeout in ms, bounded to 3000-60000."),
    command:tool.schema.string().optional().describe("Remote command for exec. Never include credentials."),
    local_path:tool.schema.string().optional().describe("Worktree-relative local path for upload/download."),
    remote_path:tool.schema.string().optional().describe("Remote file path for upload/download."),
    overwrite:tool.schema.boolean().optional().describe("Allow download to replace an existing worktree file."),
  },
  async execute(args,context){
    const ssh=await service(),target=clean(args.target),user=clean(args.user);
    if(!target||!user) throw new Error("SSH actions require target and user.");
    const port=args.port??22,common={target,user,port,timeoutMs:args.timeoutMs};
    const description=await ssh.describeTailnetSshTarget(common);
    let localPath:string|undefined,remotePath:string|undefined,command:string|undefined;
    if(args.action==="exec"){command=args.command?.trim();if(!command)throw new Error("exec requires command.");}
    if(args.action==="upload"||args.action==="download"){
      const local=clean(args.local_path);remotePath=clean(args.remote_path);
      if(!local||!remotePath)throw new Error(`${args.action} requires local_path and remote_path.`);
      const worktree=path.resolve(context.directory||context.worktree||process.cwd());
      localPath=args.action==="upload"?await uploadSource(worktree,local):await downloadDestination(worktree,local,args.overwrite===true);
    }
    const signature=JSON.stringify({action:args.action,host:description.hostname,user,port:description.port,command:command??null,localPath:localPath??null,remotePath:remotePath??null});
    await context.ask({
      permission:"ssh-remote",patterns:[signature],always:[],
      metadata:{input:{
        action:permissionAction(args.action),hostname:description.hostname,dnsName:description.dnsName??null,
        ip:description.ips[0]??null,os:description.os??"unknown",username:user,port:description.port,
        network:"Tailscale",authentication:description.authentication,password:"Not required",
        command:command??null,localPath:localPath??null,remotePath:remotePath??null,
      }},
    });
    if(args.action==="check")return output(await ssh.checkTailnetSsh(common));
    if(args.action==="debug")return output(await ssh.debugTailnetSsh(common));
    if(args.action==="exec")return output(await ssh.execTailnetSsh({...common,command:command!}));
    return output(await ssh.transferTailnetSshFile({...common,localPath,remotePath,direction:args.action}));
  },
});
