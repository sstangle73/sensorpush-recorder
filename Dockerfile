FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js config.js db.js sensorpush.js poller.js auth.js drift.js mqtt.js hvac.js notifications.js weather.js ui.html ./

CMD ["node", "server.js"]
