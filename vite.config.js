import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [
    {
      name: 'no-gz-encoding',
      configureServer(server) {
        // The app decompresses .gz data files client-side via DecompressionStream.
        // Prevent the server from adding Content-Encoding: gzip which triggers
        // automatic browser decompression and breaks the manual pipeline.
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.gz')) {
            const origSetHeader = res.setHeader.bind(res);
            res.setHeader = function (name, value) {
              if (name.toLowerCase() === 'content-encoding') return res;
              return origSetHeader(name, value);
            };
          }
          next();
        });
      },
    },
  ],
});
