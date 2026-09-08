# The arena site.
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/
RUN npm ci
COPY tsconfig*.json ./
COPY apps/web ./apps/web
RUN npm --prefix apps/web run build

FROM node:24-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web ./apps/web
COPY --from=build /repo/package.json ./
EXPOSE 3000
CMD ["npm", "--prefix", "apps/web", "run", "start"]
