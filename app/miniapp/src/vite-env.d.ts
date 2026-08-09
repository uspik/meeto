/// <reference types="vite/client" />

interface ImportMetaEnv { readonly VITE_API_BASE?: string }
interface ImportMeta { readonly env: ImportMetaEnv }

/** Штамп сборки, подставляется Vite через define */
declare const __BUILD__: string;
