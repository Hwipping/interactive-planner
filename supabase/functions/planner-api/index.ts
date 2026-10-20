// 기획안 목록·비밀번호·저장·이미지 업로드를 처리하는 Supabase Edge Function

import { createClient } from '@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

const PROJECT_BUCKET = 'planner-assets';
const OWNER_SESSION_DAYS = 100;
const ADMIN_SESSION_HOURS = 12;
const PASSWORD_ITERATIONS = 150_000;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function fail(message: string, status = 400) {
  return response({ error: message }, status);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationsText, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'pbkdf2' || !iterationsText || !saltText || !hashText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: base64UrlToBytes(saltText), iterations, hash: 'SHA-256' },
    key,
    256
  );
  const actual = new Uint8Array(bits);
  const expected = base64UrlToBytes(hashText);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  actual.forEach((byte, index) => { difference |= byte ^ expected[index]; });
  return difference === 0;
}

function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function getBearer(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function createSession(projectId: string | null, role: 'owner' | 'admin') {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const sessionLifetimeMs = role === 'owner'
    ? OWNER_SESSION_DAYS * 24 * 60 * 60 * 1000
    : ADMIN_SESSION_HOURS * 60 * 60 * 1000;
  const { error } = await supabase.from('planner_sessions').insert({
    token_hash: tokenHash,
    project_id: projectId,
    role,
    expires_at: new Date(Date.now() + sessionLifetimeMs).toISOString()
  });
  if (error) throw error;
  return token;
}

async function getSession(request: Request, projectId?: string) {
  const token = getBearer(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  let query = supabase
    .from('planner_sessions')
    .select('id, project_id, role, expires_at')
    .eq('token_hash', tokenHash)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  const { data } = await query;
  if (!data) return null;
  if (projectId && data.role !== 'admin' && data.project_id !== projectId) return null;
  return data;
}

async function getAdminPassword() {
  return Deno.env.get('ADMIN_MASTER_PASSWORD') ?? '';
}

function validateProjectInput(input: Record<string, unknown>) {
  const studentName = String(input.studentName ?? '').trim();
  const title = String(input.title ?? '').trim();
  const password = String(input.password ?? '');
  if (!studentName || !title) throw new Error('이름과 기획안 제목을 입력해 주세요.');
  if (password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다.');
  return { studentName, title, password };
}

async function signedAssetUrl(path: string | null) {
  if (!path) return '';
  const { data } = await supabase.storage.from(PROJECT_BUCKET).createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? '';
}

async function withSignedAssets(projectId: string, content: Record<string, unknown>) {
  const { data: assets } = await supabase
    .from('planner_assets')
    .select('logical_key, kind, storage_path, mime_type')
    .eq('project_id', projectId);
  const signed = await Promise.all((assets ?? []).map(async (asset) => ({
    ...asset,
    url: await signedAssetUrl(asset.storage_path)
  })));
  return { content, assets: signed };
}

async function deleteProject(projectId: string) {
  const { data: assets } = await supabase.from('planner_assets').select('storage_path').eq('project_id', projectId);
  const paths = (assets ?? []).map((asset) => asset.storage_path);
  if (paths.length > 0) await supabase.storage.from(PROJECT_BUCKET).remove(paths);
  await supabase.from('planner_assets').delete().eq('project_id', projectId);
  await supabase.from('planner_projects').delete().eq('id', projectId);
}

async function cleanupExpired() {
  const { data: projects } = await supabase
    .from('planner_projects')
    .select('id')
    .lt('expires_at', new Date().toISOString());
  for (const project of projects ?? []) await deleteProject(project.id);
  await supabase.from('planner_sessions').delete().lt('expires_at', new Date().toISOString());
  return projects?.length ?? 0;
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('이미지 데이터 형식이 올바르지 않습니다.');
  const mimeType = match[1];
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
    throw new Error('지원하지 않는 이미지 형식입니다.');
  }
  const bytes = base64UrlToBytes(match[2].replaceAll('+', '-').replaceAll('/', '_'));
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('이미지 용량은 10MB 이하만 업로드할 수 있습니다.');
  return { mimeType, bytes };
}

async function listProjects() {
  await cleanupExpired();
  const { data, error } = await supabase
    .from('planner_projects')
    .select('id, student_name, title, status, cover_asset_path, created_at, updated_at, expires_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return Promise.all((data ?? []).map(async (project) => ({
    ...project,
    cover_url: await signedAssetUrl(project.cover_asset_path)
  })));
}

async function handle(request: Request) {
  const input = await request.json().catch(() => ({}));
  const action = String(input.action ?? '');

  if (action === 'list') return response({ projects: await listProjects() });
  if (action === 'cleanup') return response({ deleted: await cleanupExpired() });

  if (action === 'create') {
    const { studentName, title, password } = validateProjectInput(input);
    const passwordHash = await hashPassword(password);
    const { data: project, error } = await supabase
      .from('planner_projects')
      .insert({ student_name: studentName, title, password_hash: passwordHash })
      .select('id, student_name, title, status, created_at, updated_at, expires_at, content')
      .single();
    if (error) throw error;
    const sessionToken = await createSession(project.id, 'owner');
    return response({ project, assets: [], sessionToken });
  }

  if (action === 'admin-login') {
    const adminPassword = await getAdminPassword();
    if (!adminPassword || String(input.password ?? '') !== adminPassword) return fail('관리자 비밀번호가 올바르지 않습니다.', 401);
    const sessionToken = await createSession(null, 'admin');
    return response({ sessionToken, projects: await listProjects() });
  }

  if (action === 'resume') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request, projectId);
    if (!session || session.role !== 'owner') return fail('저장된 접근 권한이 만료되었거나 없습니다.', 401);
    const { data: project, error } = await supabase
      .from('planner_projects')
      .select('id, student_name, title, status, content, created_at, updated_at, expires_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !project) return fail('기획안을 찾을 수 없습니다.', 404);
    const payload = await withSignedAssets(project.id, project.content ?? {});
    return response({ project, ...payload, sessionToken: getBearer(request) });
  }

  if (action === 'open') {
    const projectId = String(input.projectId ?? '');
    const password = String(input.password ?? '');
    const { data: project, error } = await supabase
      .from('planner_projects')
      .select('id, student_name, title, status, password_hash, content, created_at, updated_at, expires_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !project) return fail('기획안을 찾을 수 없습니다.', 404);
    if (!(await verifyPassword(password, project.password_hash))) return fail('비밀번호가 올바르지 않습니다.', 401);
    const sessionToken = await createSession(project.id, 'owner');
    const payload = await withSignedAssets(project.id, project.content ?? {});
    delete project.password_hash;
    return response({ project, ...payload, sessionToken });
  }

  if (action === 'admin-open') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request);
    if (!session || session.role !== 'admin') return fail('관리자 권한이 필요합니다.', 401);
    const { data: project, error } = await supabase
      .from('planner_projects')
      .select('id, student_name, title, status, content, created_at, updated_at, expires_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !project) return fail('기획안을 찾을 수 없습니다.', 404);
    const payload = await withSignedAssets(project.id, project.content ?? {});
    return response({ project, ...payload, sessionToken: getBearer(request) });
  }

  if (action === 'save') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request, projectId);
    if (!session) return fail('편집 권한이 만료되었거나 없습니다.', 401);
    const content = input.content && typeof input.content === 'object' ? input.content : {};
    const patch: Record<string, unknown> = { content };
    if (typeof input.studentName === 'string') patch.student_name = input.studentName.trim();
    if (typeof input.title === 'string') patch.title = input.title.trim() || '새 기획안';
    if (input.status === 'working' || input.status === 'complete') patch.status = input.status;
    if (typeof input.coverAssetPath === 'string') patch.cover_asset_path = input.coverAssetPath || null;
    const { error } = await supabase.from('planner_projects').update(patch).eq('id', projectId);
    if (error) throw error;
    return response({ saved: true, updatedAt: new Date().toISOString() });
  }

  if (action === 'change-password') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request, projectId);
    if (!session || session.role !== 'owner') return fail('학생 편집 권한이 만료되었거나 없습니다.', 401);
    const currentPassword = String(input.currentPassword ?? '');
    const nextPassword = String(input.nextPassword ?? '');
    if (nextPassword.length < 6) return fail('새 비밀번호는 6자 이상이어야 합니다.');
    const { data: project } = await supabase.from('planner_projects').select('password_hash').eq('id', projectId).single();
    if (!project || !(await verifyPassword(currentPassword, project.password_hash))) return fail('현재 비밀번호가 올바르지 않습니다.', 401);
    const { error } = await supabase.from('planner_projects').update({ password_hash: await hashPassword(nextPassword) }).eq('id', projectId);
    if (error) throw error;
    return response({ changed: true });
  }

  if (action === 'admin-reset-password') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request);
    if (!session || session.role !== 'admin') return fail('관리자 권한이 필요합니다.', 401);
    const nextPassword = String(input.nextPassword ?? '');
    if (nextPassword.length < 6) return fail('새 비밀번호는 6자 이상이어야 합니다.');
    const { error } = await supabase.from('planner_projects').update({ password_hash: await hashPassword(nextPassword) }).eq('id', projectId);
    if (error) throw error;
    return response({ reset: true });
  }

  if (action === 'upload-asset') {
    const projectId = String(input.projectId ?? '');
    const session = await getSession(request, projectId);
    if (!session) return fail('업로드 권한이 만료되었거나 없습니다.', 401);
    const logicalKey = String(input.logicalKey ?? '').trim();
    const kind = String(input.kind ?? 'reference');
    const dataUrl = String(input.dataUrl ?? '');
    if (!logicalKey || !dataUrl) return fail('이미지 정보가 부족합니다.');
    const { mimeType, bytes } = parseDataUrl(dataUrl);
    const extension = mimeType.split('/')[1].replace('jpeg', 'jpg');
    const { data: previous } = await supabase
      .from('planner_assets')
      .select('storage_path')
      .eq('project_id', projectId)
      .eq('logical_key', logicalKey)
      .maybeSingle();
    const storagePath = `${projectId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(PROJECT_BUCKET).upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (uploadError) throw uploadError;
    const { error: assetError } = await supabase.from('planner_assets').upsert({ project_id: projectId, logical_key: logicalKey, kind, storage_path: storagePath, mime_type: mimeType }, { onConflict: 'project_id,logical_key' });
    if (assetError) throw assetError;
    if (previous?.storage_path) await supabase.storage.from(PROJECT_BUCKET).remove([previous.storage_path]);
    const url = await signedAssetUrl(storagePath);
    return response({ logicalKey, kind, storagePath, url });
  }

  return fail('지원하지 않는 요청입니다.', 404);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    return await handle(request);
  } catch (error) {
    console.error(error);
    return fail(error instanceof Error ? error.message : '서버에서 처리하지 못했습니다.', 500);
  }
});

