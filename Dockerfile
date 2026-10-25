# ECR Public's copy of the Docker Official Image: the same tag and digest as
# Docker Hub's node:22-alpine, without Docker Hub's anonymous pull limit.
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js config.js db.js sensorpush.js poller.js auth.js drift.js mqtt.js hvac.js notifications.js weather.js backups.js groups.js ui.html ./

CMD ["node", "server.js"]
