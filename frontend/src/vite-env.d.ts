/// <reference types="vite/client" />

/**
 * The environment variables this app reads. Declaring them means a typo in
 * `import.meta.env.VITE_...` is a compile error rather than a silent undefined.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
