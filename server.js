// server.js

// Import necessary modules
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

// Create an Express application
const app = express();
// Create an HTTP server using the Express app
const server = http.createServer(app);

// Initialize Socket.IO with the HTTP server
// Configure CORS to allow connections from your GitHub Pages (or local) client
const io = socketIo(server, {
    cors: {
        // For development, use "*". In production, replace with your specific GitHub Pages URL
        // e.g., origin: "https://your-username.github.io"
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Define the port for the server to listen on.
// It will use the PORT environment variable (e.g., when deployed on Heroku), or default to 3000.
const PORT = process.env.PORT || 3000;

// --- Server-side Game State ---
// This will hold the authoritative state of the game for all connected players.
// It maps socket.id to player objects.
let players = {};
let zombies = {}; // Use an object for easier deletion by ID
let bullets = {}; // Use an object for easier deletion by ID
let nextBulletId = 0;
let nextZombieId = 0;

// Game constants (should ideally match client-side for consistent logic, but server is authoritative)
const ZOMBIE_RADIUS = 20;
const ZOMBIE_MAX_HEALTH = 100;
const ZOMBIE_BASE_SPEED = 0.5;
const ZOMBIE_BITE_DAMAGE = 5;
const ZOMBIE_BITE_INTERVAL = 1000; // 1 second

// New Knife Constants (matching client for clarity, server is authoritative)
const KNIFE_RADIUS = 70; // Radius of knife attack from player center
const KNIFE_COOLDOWN = 1500; // 1.5 seconds cooldown

// Dummy gun configs for server-side validation (optional, but good practice)
const serverGuns = {
    pistol: { damage: 20, fireRate: 300, bulletSpeed: 7, ammoPerShot: 1 },
    shotgun: { damage: 50, fireRate: 800, bulletSpeed: 5, ammoPerShot: 5 },
    assaultRifle: { damage: 15, fireRate: 100, bulletSpeed: 9, ammoPerShot: 1 },
    sonicBlaster: { damage: 30, fireRate: 25, bulletSpeed: 25, ammoPerShot: 1 }
};

// Add a simple health check endpoint for Render (or other deployment platforms)
// Render will hit this endpoint to ensure your server is running.
app.get('/health', (req, res) => {
    res.send('OK');
});

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Create a new player for this connected client
    players[socket.id] = {
        id: socket.id,
        x: Math.random() * 800, // Random spawn position for new player
        y: Math.random() * 600,
        radius: 15, // Should match client
        health: 100,
        score: 0,
        currentGun: 'pistol', // Default gun
        lastShotTime: 0,
        lastKnifeTime: 0, // Initialize last knife attack time for new player
    };

    // Send the current game state to the newly connected client
    // This allows them to see existing players, zombies, etc.
    socket.emit('currentGameState', {
        players: players,
        zombies: zombies,
        bullets: bullets
    });

    // Notify all *other* clients about the new player
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // --- Event Listeners for Client Input ---

    // Listen for player movement updates from clients
    socket.on('playerMove', (data) => {
        // Update player position on the server (authoritative)
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            // Optionally, add validation to prevent cheating, e.g., check if movement is too fast
            // players[socket.id].x = Math.max(0, Math.min(800, data.x));
            // players[socket.id].y = Math.max(0, Math.min(600, data.y));
        }
    });

    // Listen for player shooting events from clients
    socket.on('playerShoot', (data) => {
        if (players[socket.id] && serverGuns[players[socket.id].currentGun]) {
            const player = players[socket.id];
            const gun = serverGuns[player.currentGun];
            const currentTime = Date.now();

            // Server-side fire rate check to prevent cheating
            if (currentTime - player.lastShotTime > gun.fireRate) {
                const angle = Math.atan2(data.targetY - player.y, data.targetX - player.x);
                const vx = Math.cos(angle) * gun.bulletSpeed;
                const vy = Math.sin(angle) * gun.bulletSpeed;

                const bulletId = `bullet-${nextBulletId++}`;
                bullets[bulletId] = {
                    id: bulletId,
                    ownerId: socket.id, // Track who shot the bullet
                    x: player.x,
                    y: player.y,
                    vx: vx,
                    vy: vy,
                    damage: gun.damage,
                    color: gun.bulletColor, // These should be defined on the server if not passed
                    length: gun.bulletLength // These should be defined on the server if not passed
                };
                player.lastShotTime = currentTime;

                // Broadcast the new bullet to all clients
                io.emit('newBullet', bullets[bulletId]);
            }
        }
    });

    // Listen for knife attack events from clients
    socket.on('knifeAttack', () => {
        const player = players[socket.id];
        const currentTime = Date.now();

        // Server-side cooldown check for knife attack
        if (player && (currentTime - player.lastKnifeTime > KNIFE_COOLDOWN)) {
            player.lastKnifeTime = currentTime;

            // Iterate through all zombies and check for collision with knife radius
            for (const zombieId in zombies) {
                const zombie = zombies[zombieId];
                const dist = Math.sqrt(
                    Math.pow(player.x - zombie.x, 2) + Math.pow(player.y - zombie.y, 2)
                );

                if (dist < KNIFE_RADIUS + zombie.radius) {
                    // Zombie is within knife range, kill it
                    delete zombies[zombieId];
                    io.emit('removeZombie', zombieId); // Tell clients to remove the zombie

                    // Award score to the player
                    player.score += 10;
                    io.to(socket.id).emit('playerScoreUpdate', player.score); // Update specific player's score

                    console.log(`Zombie ${zombieId} killed by knife from player ${player.id}`);
                }
            }
            // Broadcast a visual knife effect to all clients (optional)
            io.emit('knifeEffect', { playerId: socket.id, x: player.x, y: player.y });
        }
    });

    // Listen for gun changes from client
    socket.on('playerChangeGun', (data) => {
        if (players[socket.id] && serverGuns[data.gunType]) {
            players[socket.id].currentGun = data.gunType;
            console.log(`Player ${socket.id} changed gun to ${data.gunType}`);
            // No need to broadcast this unless gun type affects other players' visuals/logic
        }
    });


    // Listen for grenade throws (client-side still needs to send this)
    socket.on('throwGrenade', (data) => {
        // Implement server-side grenade logic here
        // This will likely involve cooldowns, creating a grenade object on the server,
        // moving it, and then handling its explosion and damage to zombies.
        // For now, this is a placeholder.
        console.log(`Player ${socket.id} threw a grenade.`);
        // You would decrement grenade count on server, validate, then broadcast grenade updates
    });

    // Listen for a client disconnecting
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id]; // Remove player from server state
        // Notify all other clients that a player disconnected
        io.emit('playerDisconnected', socket.id);
    });
});

// --- Server-side Game Loop ---
// This loop runs on the server and updates the authoritative game state
let lastGameLoopTime = Date.now();
setInterval(() => {
    const currentTime = Date.now();
    const deltaTime = currentTime - lastGameLoopTime;
    lastGameLoopTime = currentTime;

    // Update Zombies (server-side logic)
    for (const zombieId in zombies) {
        const zombie = zombies[zombieId];
        const playerIds = Object.keys(players);
        
        if (playerIds.length > 0) {
            // Find the closest player for the zombie to target
            let closestPlayer = null;
            let minDist = Infinity;
            for (const pId of playerIds) {
                const p = players[pId];
                const dist = Math.sqrt(Math.pow(p.x - zombie.x, 2) + Math.pow(p.y - zombie.y, 2));
                if (dist < minDist) {
                    minDist = dist;
                    closestPlayer = p;
                }
            }

            if (closestPlayer) {
                const angle = Math.atan2(closestPlayer.y - zombie.y, closestPlayer.x - zombie.x);
                zombie.x += Math.cos(angle) * zombie.speed;
                zombie.y += Math.sin(angle) * zombie.speed;

                // Simple collision detection with players
                const distPlayerZombie = Math.sqrt(Math.pow(closestPlayer.x - zombie.x, 2) + Math.pow(closestPlayer.y - zombie.y, 2));
                if (distPlayerZombie < closestPlayer.radius + ZOMBIE_BITE_RADIUS) {
                    if (currentTime - zombie.lastBiteTime > ZOMBIE_BITE_INTERVAL) {
                        closestPlayer.health -= ZOMBIE_BITE_DAMAGE;
                        zombie.lastBiteTime = currentTime;
                        // Send health update to specific player or broadcast if health visible to all
                        io.to(closestPlayer.id).emit('playerHealthUpdate', closestPlayer.health);
                        if (closestPlayer.health <= 0) {
                            // Handle player death on server
                            io.emit('playerDied', closestPlayer.id);
                            delete players[closestPlayer.id];
                        }
                    }
                }
            }
        }
    }

    // Update Bullets (server-side logic)
    for (const bulletId in bullets) {
        const bullet = bullets[bulletId];
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        // Remove bullet if out of bounds (assuming canvas is 800x600)
        if (bullet.x < 0 || bullet.x > 800 || bullet.y < 0 || bullet.y > 600) {
            delete bullets[bulletId];
            io.emit('removeBullet', bulletId); // Tell clients to remove
            continue;
        }

        // Bullet-zombie collision detection on server
        for (const zombieId in zombies) {
            const zombie = zombies[zombieId];
            const dist = Math.sqrt(Math.pow(zombie.x - bullet.x, 2) + Math.pow(zombie.y - bullet.y, 2));
            if (dist < zombie.radius + bullet.radius) {
                zombie.health -= bullet.damage;
                delete bullets[bulletId]; // Remove bullet
                io.emit('removeBullet', bulletId); // Tell clients to remove
                
                if (zombie.health <= 0) {
                    delete zombies[zombieId]; // Remove zombie
                    io.emit('removeZombie', zombieId); // Tell clients to remove
                    // Award score to the bullet owner if needed
                    if (players[bullet.ownerId]) {
                        players[bullet.ownerId].score += 10;
                        io.to(bullet.ownerId).emit('playerScoreUpdate', players[bullet.ownerId].score);
                    }
                } else {
                    io.emit('zombieHealthUpdate', { id: zombie.id, health: zombie.health });
                }
                break; // Bullet hit a zombie, no need to check other zombies
            }
        }
    }
    
    // --- Zombie Spawning (Server-side) ---
    const MAX_ZOMBIES = 10; // Adjust as needed
    if (Object.keys(zombies).length < MAX_ZOMBIES && Math.random() < 0.01) { // 1% chance each tick
        const side = Math.floor(Math.random() * 4);
        let x, y;
        const radius = ZOMBIE_RADIUS;
        const maxHealth = ZOMBIE_MAX_HEALTH;
        const speed = ZOMBIE_BASE_SPEED;

        switch (side) {
            case 0: // Top
                x = Math.random() * 800;
                y = -radius;
                break;
            case 1: // Right
                x = 800 + radius;
                y = Math.random() * 600;
                break;
            case 2: // Bottom
                x = Math.random() * 800;
                y = 600 + radius;
                break;
            case 3: // Left
                x = -radius;
                y = Math.random() * 600;
                break;
        }

        const zombieId = `zombie-${nextZombieId++}`;
        zombies[zombieId] = {
            id: zombieId,
            x: x,
            y: y,
            radius: radius,
            health: maxHealth,
            maxHealth: maxHealth,
            speed: speed,
            lastBiteTime: 0
        };
        io.emit('newZombie', zombies[zombieId]); // Tell clients about new zombie
    }


    // Send periodic updates to all clients
    // This could be optimized to send only changed data, but for a simple game,
    // sending full state every tick can be acceptable.
    io.emit('gameUpdate', {
        players: players,
        zombies: zombies,
        bullets: bullets
    });

}, 1000 / 60); // Run server game loop at 60 FPS

// Start the server
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the game at http://localhost:${PORT}`);
});
