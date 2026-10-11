# Cibles portables : Windows (PowerShell, cmd, Git Bash), Linux et macOS.
# Toute logique passe par node ou npm : aucune commande propre à un shell (bash, cp -n, VAR=x cmd),
# car GNU make sous Windows lance cmd.exe, et « bash » peut y désigner WSL.
# Windows : GNU make (ex. choco install make) et Node.js 22 dans le PATH.
.PHONY: setup dev app worker db-deploy db-seed build mailpit mailpit-stop alpine-deploy alpine-status

setup:
	node -e "const f=require('fs');if(!f.existsSync('.env'))f.copyFileSync('.env.example','.env');f.mkdirSync('data',{recursive:true})"
	npm install
	npm run db:generate
	npm run db:deploy
	npm run db:seed

mailpit:
	@node scripts/mailpit.mjs start

mailpit-stop:
	@node scripts/mailpit.mjs stop

dev:
	@node scripts/dev.mjs --check-ports
	@$(MAKE) --no-print-directory db-deploy
	@$(MAKE) --no-print-directory mailpit
	@echo API : http://127.0.0.1:3001
	@echo Web : http://127.0.0.1:5173, proxy /api vers API
	@echo Mailpit UI : http://127.0.0.1:8025
	@echo Worker : relances et file des e-mails, inclus dans npm run dev
	npm run dev

# Build puis API en mode production locale sur :3000 (sert aussi l'admin compilé).
app: build
	node scripts/app-local.mjs

build:
	npm run build -w @kouzia-erp/web

worker:
	npm run worker

db-deploy:
	npm run db:deploy

db-seed:
	npm run db:seed

# Déploiement vers le CT Alpine (Linux, macOS ou Git Bash : rsync et ssh requis).
#   make alpine-deploy HOST=root@10.0.0.50
alpine-deploy:
	node -e "if(!process.argv[1])(console.error('Usage: make alpine-deploy HOST=user@ct-ip'),process.exit(1))" "$(HOST)"
	bash scripts/alpine/deploy-rsync.sh "$(HOST)"

alpine-status:
	node -e "if(!process.argv[1])(console.error('Usage: make alpine-status HOST=user@ct-ip'),process.exit(1))" "$(HOST)"
	ssh $(HOST) kouziactl status
