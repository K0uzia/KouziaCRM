.PHONY: setup dev app worker db-deploy db-seed build

setup:
	cp -n .env.example .env || true
	mkdir -p data
	npm install
	npm run db:generate
	npm run db:deploy
	npm run db:seed

dev:
	@echo "API : http://127.0.0.1:3001"
	@echo "Web : http://127.0.0.1:5173 (proxy /api → API)"
	npm run dev

app: build
	NODE_ENV=production WEB_DIST="$(CURDIR)/apps/web/dist" API_PORT=3000 WEB_ORIGIN=http://localhost:3000 \
	  npx tsx --env-file=.env --tsconfig apps/api/tsconfig.json apps/api/src/index.ts

build:
	npm run build -w @kouziacrm/web

worker:
	npm run worker

db-deploy:
	npm run db:deploy

db-seed:
	npm run db:seed
