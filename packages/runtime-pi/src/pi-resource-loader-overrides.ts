/**
 * Canopy-managed Pi mode deliberately opts out of Pi's ambient local resources.
 *
 * Canopy supplies the system prompt, Skills and product tools explicitly. Do not
 * let a user project's ancestor context files, extensions, or APPEND_SYSTEM.md
 * silently alter that managed runtime. Inline extension factories remain
 * available: Pi loads them independently of `noExtensions`.
 */
export interface AppProjectInstructionFile {
  path: string
  content: string
}

export function createAppManagedResourceLoaderOptions() {
  return {
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    // An explicit empty source prevents Pi from discovering APPEND_SYSTEM.md.
    appendSystemPrompt: [],
  }
}

/**
 * Pi still owns the final <project_context> formatting. Canopy supplies this override only after validating explicit Canopy-managed
 * workspace paths and user-authorized project paths, so no ambient context-file
 * discovery is re-enabled.
 */
export function createAppProjectInstructionFilesOverride(files: AppProjectInstructionFile[]) {
  const agentsFiles = files.map(({ path, content }) => ({ path, content }))
  return () => ({ agentsFiles })
}


/** Keep managed workspace rules ahead of user-project rules in Pi project context. */
export function combineAppInstructionFiles(
  workspaceFile: AppProjectInstructionFile | undefined,
  projectFiles: AppProjectInstructionFile[],
): AppProjectInstructionFile[] {
  return workspaceFile ? [workspaceFile, ...projectFiles] : projectFiles
}
