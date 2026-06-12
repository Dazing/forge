# Build the Vite app, serve the static bundle with nginx.
FROM node:lts-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
