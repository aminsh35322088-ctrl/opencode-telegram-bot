import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "../../utils/logger.js";
import { getFreeModelSourcesEnabled } from "../stores/settings-store.js";
import {
  restartFreeModelSources,
  setFreeModelSourceCredential,
  type FreeModelSourceID,
} from "./free-model-source-service.js";

export type PairableFreeModelSourceID = Extract<FreeModelSourceID, "qwen" | "glm" | "ds">;

export interface FreeSourceLoginPairing {
  id: string;
  sourceID: PairableFreeModelSourceID;
  helperUrl: string;
  expiresAt: number;
}

interface PendingPairing {
  sourceID: PairableFreeModelSourceID;
  secretHash: Buffer;
  expiresAt: number;
  consumed: boolean;
}

const PAIRING_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_PATH = "/free-source-auth/connect";
const HELPER_SCRIPT_PATH = "/free-source-auth/helper.ps1";
const COMPLETE_PATH = "/free-source-auth/complete";

const pairings = new Map<string, PendingPairing>();
let server: Server | null = null;

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function publicBaseUrl(): string | null {
  const explicit = process.env.FREE_SOURCE_AUTH_PUBLIC_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return railwayDomain ? `https://${railwayDomain}` : null;
}

function cleanupPairings(now = Date.now()): void {
  for (const [id, pairing] of pairings) {
    if (pairing.expiresAt <= now) pairings.delete(id);
  }
}

export function createFreeSourceLoginPairing(sourceID: PairableFreeModelSourceID): FreeSourceLoginPairing {
  const base = publicBaseUrl();
  if (!base) throw new Error("Automatic login helper needs a public HTTPS bot domain.");
  cleanupPairings();
  const id = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairings.set(id, { sourceID, secretHash: hashSecret(secret), expiresAt, consumed: false });
  const fragment = new URLSearchParams({ id, secret, source: sourceID }).toString();
  return { id, sourceID, helperUrl: `${base}${CONNECT_PATH}#${fragment}`, expiresAt };
}

export function getFreeSourceLoginPairingStatus(id: string): "pending" | "connected" | "expired" | "missing" {
  const pairing = pairings.get(id);
  if (!pairing) return "missing";
  if (pairing.consumed) return "connected";
  if (pairing.expiresAt <= Date.now()) {
    pairings.delete(id);
    return "expired";
  }
  return "pending";
}

export function cancelFreeSourceLoginPairing(id: string): boolean {
  return pairings.delete(id);
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

function json(res: ServerResponse, status: number, value: Record<string, unknown>): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function connectPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Telegram Bot Login Helper</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#111827;background:#f8fafc}.card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:26px;box-shadow:0 8px 30px #0f172a12}h1{font-size:22px;margin:0 0 10px}p{line-height:1.55}.muted{color:#64748b}.ok{color:#047857}.bad{color:#b91c1c}button{border:0;border-radius:12px;padding:12px 16px;font-weight:700;cursor:pointer;background:#111827;color:#fff}</style>
</head><body><div class="card"><h1>Free Model Source Login Helper</h1><p id="status">Reading pairing request…</p>
<div id="actions" hidden><p>Download and run the Windows helper. It opens a fresh Chrome/Edge window. Sign in normally there; passwords and 2FA stay inside the provider website. Only the resulting session token is sent to your own bot over HTTPS.</p>
<button id="download">Download Windows helper (.ps1)</button>
<p class="muted">The pairing expires in 10 minutes and is single-use. The secret stays in the URL fragment, which is not sent to Railway in the HTTP request.</p></div></div>
<script>(async()=>{const s=document.getElementById('status'),a=document.getElementById('actions'),p=new URLSearchParams(location.hash.slice(1)),id=p.get('id'),secret=p.get('secret'),source=p.get('source');if(!id||!secret||!['qwen','glm','ds'].includes(source||'')){s.className='bad';s.textContent='Invalid pairing link.';return}const names={qwen:'Qwen',glm:'GLM / Z.AI',ds:'DeepSeek'};s.className='ok';s.textContent='Ready to connect '+names[source]+'.';a.hidden=false;document.getElementById('download').onclick=async()=>{try{const r=await fetch('${HELPER_SCRIPT_PATH}',{cache:'no-store'});if(!r.ok)throw new Error('download failed');let ps=await r.text();const endpoint=location.origin+'${COMPLETE_PATH}';ps=ps.replaceAll('__PAIR_ID__',id).replaceAll('__PAIR_SECRET__',secret).replaceAll('__PAIR_SOURCE__',source).replaceAll('__PAIR_ENDPOINT__',endpoint);const b=new Blob([ps],{type:'text/plain;charset=utf-8'}),x=document.createElement('a');x.href=URL.createObjectURL(b);x.download='opencode-'+source+'-login.ps1';x.click();setTimeout(()=>URL.revokeObjectURL(x.href),2000)}catch(e){s.className='bad';s.textContent='Could not prepare helper: '+e}}})().catch(()=>{});</script>
</body></html>`;
}

function helperScript(): string {
  return String.raw`# OpenCode Telegram Bot - one-time login helper
# Delete this file after use; it contains a short-lived single-use pairing secret.
$ErrorActionPreference = "Stop"
$PairId = "__PAIR_ID__"
$PairSecret = "__PAIR_SECRET__"
$Source = "__PAIR_SOURCE__"
$Endpoint = "__PAIR_ENDPOINT__"

$Provider = @{
  qwen = @{ Name = "Qwen"; Url = "https://chat.qwen.ai"; Expr = "(() => localStorage.getItem('token') || '')()" }
  glm  = @{ Name = "GLM / Z.AI"; Url = "https://chat.z.ai"; Expr = "(() => localStorage.getItem('token') || '')()" }
  ds   = @{ Name = "DeepSeek"; Url = "https://chat.deepseek.com/sign_in"; Expr = "(() => { try { const raw=localStorage.getItem('userToken'); if(!raw)return ''; const o=JSON.parse(raw); return (o && o.value) ? o.value : ''; } catch(e) { return ''; } })()" }
}[$Source]
if (-not $Provider) { throw "Unsupported provider." }

function Find-Browser {
  $candidates = @(
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
    "${env:PROGRAMFILES(X86)}\Google\Chrome\Application\chrome.exe",
    "$env:PROGRAMFILES\Microsoft\Edge\Application\msedge.exe",
    "${env:PROGRAMFILES(X86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  throw "Chrome or Microsoft Edge was not found."
}

function Invoke-CdpEvaluate([string]$WsUrl, [string]$Expression) {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(8))
  try {
    $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).GetAwaiter().GetResult()
    $payload = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$Expression; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
    $buf = New-Object byte[] 262144
    while ($true) {
      $ms = [IO.MemoryStream]::new()
      do {
        $recv = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).GetAwaiter().GetResult()
        if ($recv.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return "" }
        $ms.Write($buf,0,$recv.Count)
      } while (-not $recv.EndOfMessage)
      $msg = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
      if ($msg.id -eq 1) {
        $v = $msg.result.result.value
        if ($null -eq $v) { return "" }
        return [string]$v
      }
    }
  } catch { return "" } finally { try{$ws.Dispose()}catch{}; $cts.Dispose() }
}

$browser = Find-Browser
$port = Get-Random -Minimum 12000 -Maximum 22000
$profile = Join-Path $env:TEMP ("opencode-login-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $profile -Force | Out-Null

Write-Host ""
Write-Host ("Opening " + $Provider.Name + " in a clean browser window...") -ForegroundColor Cyan
Write-Host "Sign in normally. Complete CAPTCHA/2FA yourself if the site requests it." -ForegroundColor Yellow
Write-Host "Your password is never read or sent by this helper." -ForegroundColor Green
Write-Host ""

$proc = Start-Process -FilePath $browser -ArgumentList @("--remote-debugging-port=$port","--user-data-dir=$profile","--no-first-run","--no-default-browser-check",$Provider.Url) -PassThru
$deadline = (Get-Date).AddMinutes(8)
$credential = ""
try {
  while ((Get-Date) -lt $deadline -and -not $credential) {
    Start-Sleep -Milliseconds 1200
    try {
      $targets = Invoke-RestMethod -Uri ("http://127.0.0.1:$port/json/list") -TimeoutSec 3
      foreach ($t in @($targets)) {
        if ($t.type -ne "page" -or -not $t.webSocketDebuggerUrl) { continue }
        $credential = Invoke-CdpEvaluate ([string]$t.webSocketDebuggerUrl) ([string]$Provider.Expr)
        if ($credential) { break }
      }
    } catch {}
  }
  if (-not $credential) { throw "Login token was not detected before timeout. Finish login fully and start a fresh pairing." }
  $body = @{ id=$PairId; source=$Source; credential=$credential } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Uri $Endpoint -Method Post -Headers @{ Authorization=("Pair " + $PairSecret) } -ContentType "application/json" -Body $body -TimeoutSec 20
  if (-not $result.ok) { throw "The bot did not accept the pairing." }
  Write-Host ""
  Write-Host ("Connected " + $Provider.Name + " successfully.") -ForegroundColor Green
  Write-Host "Return to Telegram and tap Check connection."
} finally {
  $credential = $null
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 400
  try { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function credentialValid(sourceID: PairableFreeModelSourceID, value: string): boolean {
  if (value.length < 20 || value.length > 12_000 || /[\r\n]/.test(value)) return false;
  return sourceID !== "qwen" || value.split(".").length >= 3;
}

async function complete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const secret = auth.startsWith("Pair ") ? auth.slice(5).trim() : "";
  if (!secret) { json(res, 401, { ok:false, error:"missing_pairing_secret" }); return; }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    json(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, { ok:false, error:"invalid_request" });
    return;
  }

  const id = typeof body.id === "string" ? body.id : "";
  const sourceID = typeof body.source === "string" ? body.source as PairableFreeModelSourceID : null;
  const credential = typeof body.credential === "string" ? body.credential.trim() : "";
  const pairing = pairings.get(id);
  if (!pairing || pairing.expiresAt <= Date.now() || pairing.consumed) {
    pairings.delete(id);
    json(res, 410, { ok:false, error:"pairing_expired_or_used" });
    return;
  }
  const supplied = hashSecret(secret);
  if (supplied.length !== pairing.secretHash.length || !timingSafeEqual(supplied, pairing.secretHash)) {
    json(res, 401, { ok:false, error:"invalid_pairing_secret" });
    return;
  }
  if (sourceID !== pairing.sourceID || !credentialValid(pairing.sourceID, credential)) {
    json(res, 400, { ok:false, error:"invalid_credential" });
    return;
  }

  pairing.consumed = true;
  try {
    await setFreeModelSourceCredential(pairing.sourceID, credential);
    if (getFreeModelSourcesEnabled() && !await restartFreeModelSources()) {
      throw new Error("free-source runtime restart failed");
    }
    json(res, 200, { ok:true, source:pairing.sourceID });
    logger.info(`[FreeSourceLogin] Connected ${pairing.sourceID} through one-time local browser pairing`);
  } catch (error) {
    pairing.consumed = false;
    logger.warn(`[FreeSourceLogin] Pairing apply failed for ${pairing.sourceID}`, error);
    json(res, 503, { ok:false, error:"apply_failed" });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/healthz") { json(res,200,{ok:true}); return; }
  if (req.method === "GET" && url.pathname === CONNECT_PATH) {
    res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    send(res,200,connectPage(),"text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === HELPER_SCRIPT_PATH) {
    res.setHeader("Content-Disposition",'attachment; filename="opencode-free-source-login.ps1"');
    send(res,200,helperScript(),"text/plain; charset=utf-8");
    return;
  }
  if (req.method === "POST" && url.pathname === COMPLETE_PATH) { await complete(req,res); return; }
  json(res,404,{ok:false,error:"not_found"});
}

export async function startFreeSourceLoginPairingServer(): Promise<boolean> {
  if (server) return true;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logger.info("[FreeSourceLogin] Pairing server disabled: PORT is not configured");
    return false;
  }
  const active = createServer((req,res)=>{
    req.setTimeout(REQUEST_TIMEOUT_MS,()=>req.destroy());
    void handle(req,res).catch((error)=>{
      logger.warn("[FreeSourceLogin] HTTP request failed",error);
      if (!res.headersSent) json(res,500,{ok:false,error:"internal_error"}); else res.end();
    });
  });
  active.requestTimeout = REQUEST_TIMEOUT_MS;
  active.headersTimeout = REQUEST_TIMEOUT_MS + 2_000;
  await new Promise<void>((resolve,reject)=>{
    const onError=(error:Error)=>{active.off("listening",onListening);reject(error);};
    const onListening=()=>{active.off("error",onError);resolve();};
    active.once("error",onError); active.once("listening",onListening); active.listen(port,"0.0.0.0");
  });
  server = active;
  logger.info(`[FreeSourceLogin] Pairing server listening on port ${port}`);
  return true;
}

export async function stopFreeSourceLoginPairingServer(): Promise<void> {
  const active=server;
  server=null;
  pairings.clear();
  if(!active)return;
  await new Promise<void>((resolve)=>active.close(()=>resolve()));
}
