// Managed applications run with NODE_ENV=production, including build subprocesses.
// A source build still needs TypeScript, Vite and @types packages. Explicit include
// wins over NODE_ENV / npm omit=dev without weakening the runtime environment.
export function buildDependencyArgs(){
  return ['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'];
}
