import { defineConfig } from 'vite';

// SharedArrayBuffer 需要跨源隔离：
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
// 开发服务器与 preview 均下发；其它部署方式见 README。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  worker: {
    format: 'es',
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
