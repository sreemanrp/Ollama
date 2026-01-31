FROM node:20-alpine

WORKDIR /app

# install required system deps
RUN apk add --no-cache libc6-compat

# install node dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# copy source
COPY . .

# environment defaults
ENV NODE_ENV=production
ENV SELF_HEAL=true

# start the bot
CMD ["node", "index.js"]
