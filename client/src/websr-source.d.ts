// The published package includes both a UMD build and its TypeScript source.
// Use the source at runtime to avoid webpack's eval-based development bundle,
// while taking the public API types from its published declaration file.
declare module 'websr-audited-source' {
  export {default} from '@websr/websr';
}
