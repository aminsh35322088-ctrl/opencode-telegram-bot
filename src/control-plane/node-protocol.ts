import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface NodeIdentity {nodeId: string; generation: number; chatId: number; threadId: number;}
export interface NodeEnvelope extends NodeIdentity {
  version: 1; sessionId?: string; operation: string; payload: unknown; timestamp: number; nonce: string;
}

/** Request-driven, durable replay admission. No timers or outbound traffic. */
export class NodeProtocol {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly replayPath: string, private readonly now = Date.now) {}
  sign(envelope: NodeEnvelope, secret: string): {body: string; signature: string} {
    const body = JSON.stringify(envelope);
    return {body,signature:createHmac("sha256",secret).update(body,"utf8").digest("hex")};
  }
  async verify(body: string, signature: string, identity: NodeIdentity, secret: string): Promise<NodeEnvelope> {
    if (Buffer.byteLength(body)>10*1024*1024 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error("Invalid node signature");
    const expected = createHmac("sha256",secret).update(body,"utf8").digest();
    if (!timingSafeEqual(expected,Buffer.from(signature,"hex"))) throw new Error("Invalid node signature");
    const envelope = JSON.parse(body) as NodeEnvelope;
    if (envelope.version!==1 || !Number.isSafeInteger(envelope.generation) || !Number.isSafeInteger(envelope.chatId) || !Number.isSafeInteger(envelope.threadId) ||
      Object.entries(identity).some(([key,value])=>envelope[key as keyof NodeIdentity]!==value)) throw new Error("Invalid node identity");
    if (!Number.isSafeInteger(envelope.timestamp) || Math.abs(this.now()-envelope.timestamp)>60_000) throw new Error("Invalid node timestamp");
    if (!/^[a-zA-Z0-9_-]{24,128}$/.test(envelope.nonce) || typeof envelope.operation!=="string" || envelope.operation.length>80 ||
      (envelope.sessionId!==undefined && (typeof envelope.sessionId!=="string" || envelope.sessionId.length>256))) throw new Error("Invalid node envelope");
    const admission = this.queue.then(async()=>{
      let entries: Record<string,number> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(this.replayPath,"utf8"));
        if (!parsed || typeof parsed!=="object" || Array.isArray(parsed) || Object.values(parsed).some(value=>!Number.isSafeInteger(value))) throw new Error("Invalid replay state");
        entries=parsed as Record<string,number>;
      } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
      entries=Object.fromEntries(Object.entries(entries).filter(([,expiry])=>expiry>this.now()));
      const key=`${envelope.nodeId}:${envelope.generation}:${envelope.nonce}`;
      if (Object.hasOwn(entries,key)) throw new Error("Node request replay rejected");
      if (Object.keys(entries).length>=4096) throw new Error("Replay admission capacity exceeded");
      entries[key]=this.now()+120_000;
      await mkdir(dirname(this.replayPath),{recursive:true,mode:0o700});
      const file=await open(`${this.replayPath}.tmp`,"w",0o600);
      try {await file.writeFile(JSON.stringify(entries));await file.sync();} finally {await file.close();}
      await rename(`${this.replayPath}.tmp`,this.replayPath);
      const directory=await open(dirname(this.replayPath),"r");
      try {await directory.sync();} finally {await directory.close();}
    });
    this.queue=admission.catch(()=>{});
    await admission;
    return envelope;
  }
}
