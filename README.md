# 🎰 Casino Amigos

Casino online con ruleta europea en tiempo real para jugar con amigos.

## Características

- **Registro/Login** con usuario y contraseña — cada jugador empieza con 1000 fichas
- **Ruleta europea** con los 37 números (0–36) en el orden real del cilindro
- **Animación** de giro con los números desplazándose de derecha a izquierda
- **Apuestas en el tablero**: pleno (1 número), caballo (2), esquina (4), docena, columna, rojo/negro, par/impar, etc.
- **Fichas** de 1, 5, 25, 50, 100, 500, 1000 y 2500 con colores distintos
- **Tiempo real** — todos los jugadores ven la misma ruleta sincronizada vía WebSocket
- **Rondas automáticas**: 10s apuestas → animación → resultado → reparto
- **Clasificación** general, diaria y semanal ordenada por balance/beneficio

## Tecnologías

- **Backend**: Node.js, Express, Socket.io, better-sqlite3, bcryptjs
- **Frontend**: HTML, CSS, JavaScript vanilla
- **Base de datos**: SQLite (persistente en disco)

## Instalación local

```bash
# Clonar el repositorio
git clone <tu-repo>
cd casino-amigos

# Instalar dependencias
npm install

# Iniciar el servidor
npm start

# Abrir http://localhost:3000 en el navegador
```

## Despliegue gratuito en Render

1. Sube el proyecto a un repositorio en GitHub
2. Ve a [render.com](https://render.com) y crea una cuenta gratuita
3. Haz clic en **New > Web Service**
4. Conecta tu repositorio de GitHub
5. Configura:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
6. Haz clic en **Create Web Service**

> **Nota**: En el plan gratuito de Render, el servicio se apaga tras 15 minutos de inactividad. La primera visita tras la inactividad tarda unos 30 segundos en arrancar.

### Alternativa: Railway

1. Ve a [railway.app](https://railway.app) y crea una cuenta
2. Haz clic en **New Project > Deploy from GitHub**
3. Selecciona el repositorio
4. Railway detectará automáticamente que es un proyecto Node.js
5. Despliega automáticamente

## Estructura del proyecto

```
casino-amigos/
├── package.json          # Dependencias
├── server.js             # Servidor Express + Socket.io + SQLite
├── public/
│   ├── index.html        # Página principal
│   ├── style.css         # Estilos (tema casino oscuro)
│   └── app.js            # Lógica del cliente
└── README.md
```

## Cómo apostar

1. **Selecciona una ficha** haciendo clic en las fichas de la barra
2. **Haz clic en el tablero** para colocar la ficha:
   - **Centro de un número** → apuesta pleno (paga 35:1)
   - **Borde entre dos números** → apuesta caballo/split (paga 17:1)
   - **Esquina entre cuatro números** → apuesta esquina/corner (paga 8:1)
   - **Apuestas exteriores** → docena, columna, rojo/negro, par/impar, etc.
3. Puedes colocar múltiples fichas en distintas posiciones
4. Haz clic en **Limpiar Apuestas** para retirar todas tus apuestas

## Pagos

| Tipo de apuesta | Cobertura | Pago |
|---|---|---|
| Pleno | 1 número | 35:1 |
| Caballo | 2 números | 17:1 |
| Calle | 3 números | 11:1 |
| Esquina | 4 números | 8:1 |
| Línea | 6 números | 5:1 |
| Docena / Columna | 12 números | 2:1 |
| Rojo / Negro / Par / Impar / 1-18 / 19-36 | 18 números | 1:1 |
