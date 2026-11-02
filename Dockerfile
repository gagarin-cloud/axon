FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node fetches CUDA binaries on linux/x64 by default; axon runs on CPU.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ARG AXON_EMBED_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX
ARG AXON_EMBED_DTYPE=q8
ENV NODE_ENV=production \
    AXON_HTTP_HOST=0.0.0.0 \
    AXON_MODEL_DIR=/app/.models \
    AXON_EMBED_MODEL=$AXON_EMBED_MODEL \
    AXON_EMBED_DTYPE=$AXON_EMBED_DTYPE
COPY --from=build /app/node_modules node_modules
# Bake the embedding model (~600 MB at q8) into the image so containers start in about a second, offline.
# It sits right after node_modules and before the application code on purpose: this layer then survives
# a code change in the build cache, so a deploy rebuilds the server without downloading the model again.
# The same files TransformersEmbedder loads, from the same directory; a serve that cannot find them
# locally would try the network, and the readiness probe would say so.
RUN node -e "const t=require('@huggingface/transformers');t.env.cacheDir=process.env.AXON_MODEL_DIR;\
  t.pipeline('feature-extraction',process.env.AXON_EMBED_MODEL,{dtype:process.env.AXON_EMBED_DTYPE}).then(()=>process.exit(0))" \
  && chown -R node:node /app/.models
COPY --from=build /app/dist dist
COPY package.json ./
COPY migrations migrations
COPY eval eval
USER node
EXPOSE 7717
CMD ["node", "dist/cli.js", "serve"]
