const { db, encrypt, decrypt, createId } = require('./database');

const maximumDocumentBytes = 2 * 1024 * 1024;
const maximumContextCharacters = 250000;

function createProject(organizationId, userId, name, context = '') {
  const projectName = typeof name === 'string' ? name.trim().slice(0, 160) : '';
  if (projectName.length < 2) throw new Error('Project name must be at least 2 characters.');
  if (typeof context !== 'string' || Buffer.byteLength(context, 'utf8') > maximumDocumentBytes) {
    throw new Error('Project notes must be text under 2 MB.');
  }
  const id = createId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, organization_id, name, context, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, projectName, encrypt(context), userId, now, now);
  return { id, name: projectName, created_at: now, updated_at: now };
}

function listProjects(organizationId) {
  return db.prepare(`
    SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(d.id) AS document_count
    FROM projects p LEFT JOIN documents d ON d.project_id = p.id
    WHERE p.organization_id = ?
    GROUP BY p.id ORDER BY p.updated_at DESC
  `).all(organizationId);
}

function getProject(organizationId, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE organization_id = ? AND id = ?')
    .get(organizationId, projectId);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    context: decrypt(project.context),
    created_at: project.created_at,
    updated_at: project.updated_at
  };
}

function listDocuments(organizationId, projectId) {
  const project = db.prepare('SELECT id FROM projects WHERE organization_id = ? AND id = ?')
    .get(organizationId, projectId);
  if (!project) return null;
  return db.prepare(`
    SELECT d.id, d.name, d.created_at FROM documents d
    WHERE d.project_id = ? ORDER BY d.created_at DESC
  `).all(projectId);
}

function addDocument(organizationId, projectId, userId, name, content) {
  const project = db.prepare('SELECT id FROM projects WHERE organization_id = ? AND id = ?')
    .get(organizationId, projectId);
  if (!project) throw new Error('Project not found in this workspace.');
  const fileName = typeof name === 'string' ? name.trim().replace(/[\\/]/g, '_').slice(0, 180) : '';
  if (!fileName) throw new Error('Document name is required.');
  if (typeof content !== 'string' || !content.trim()) throw new Error('Document content is required.');
  if (Buffer.byteLength(content, 'utf8') > maximumDocumentBytes) {
    throw new Error('Each document is limited to 2 MB.');
  }
  const id = createId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents (id, project_id, name, content, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, projectId, fileName, encrypt(content), userId, now);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  return { id, project_id: projectId, name: fileName, created_at: now };
}

function deleteProject(organizationId, projectId, userId, role) {
  const project = db.prepare(`
    SELECT id, created_by FROM projects WHERE organization_id = ? AND id = ?
  `).get(organizationId, projectId);
  if (!project) return false;
  if (project.created_by !== userId && !['owner', 'admin', 'company_admin'].includes(role)) {
    throw new Error('Only the project creator or a workspace admin can delete this project.');
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  return true;
}

function saveProjectArtifact(organizationId, projectId, userId, artifact) {
  const project = db.prepare('SELECT id FROM projects WHERE organization_id = ? AND id = ?')
    .get(organizationId, projectId);
  if (!project) throw new Error('Project not found in this workspace.');
  const id = createId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_artifacts (id, project_id, artifact_type, content, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, projectId, 'project_pack', encrypt(JSON.stringify(artifact)), userId, now);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  return id;
}

function assembleProjectContext(organizationId, projectId, additionalContext = '') {
  const project = getProject(organizationId, projectId);
  if (!project) return null;
  if (typeof additionalContext !== 'string') throw new Error('Additional project context must be text.');
  const documents = db.prepare(`
    SELECT name, content FROM documents WHERE project_id = ? ORDER BY created_at
  `).all(projectId);
  const artifact = db.prepare(`
    SELECT content FROM project_artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(projectId);
  const sections = [
    project.context ? `Project notes:\n${project.context}` : '',
    ...documents.map((document) => `${document.name}:\n${decrypt(document.content)}`),
    artifact ? `Latest generated project pack:\n${decrypt(artifact.content)}` : '',
    additionalContext.trim() ? `New meeting or request:\n${additionalContext.trim()}` : ''
  ].filter(Boolean);
  const context = sections.join('\n\n---\n\n');
  if (context.length > maximumContextCharacters) {
    throw new Error('Combined project context exceeds 250,000 characters. Remove older or oversized documents.');
  }
  return { project, context };
}

module.exports = {
  createProject,
  listProjects,
  getProject,
  listDocuments,
  deleteProject,
  addDocument,
  saveProjectArtifact,
  assembleProjectContext,
  maximumDocumentBytes
};
