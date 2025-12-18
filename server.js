const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const admin = require('firebase-admin');
const sanitizeHtml = require('sanitize-html');
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log("Carregando credenciais do Firebase a partir do Environment Variable...");
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  console.log("Carregando credenciais do Firebase a partir do arquivo service-account-key.json local...");
  serviceAccount = require('./service-account-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
let rooms = {};

const POINTS_PER_ANSWER = 1000;
const STREAK_BONUS = 20;
const DEFAULT_QUESTION_TIME = 30; // Renomeado para evitar confusão
const PREPARE_TIME_SECONDS = 5;

// Perguntas de fallback caso o host não envie nada (apenas para teste)
const fallbackQuestions = [
    {
        instruction: "Teste de Conexão",
        text: "Aguardando o Host...",
        options: ["Opção A", "Opção B"],
        correctAnswerIndices: [0],
        syllogismData: {}
    }
];

function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function advanceToNextQuestion(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentQuestionIndex++;
    
    if (room.currentQuestionIndex >= room.questions.length) {
        endGame(roomCode);
        return;
    }

    room.gameState = 'showingQuestion';
    room.answers = {};
    room.questionStartTime = Date.now();
    const currentQuestion = room.questions[room.currentQuestionIndex];

    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'showingQuestion',
        questionData: currentQuestion, 
        questionText: currentQuestion.text,
        instruction: currentQuestion.instruction, 
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        timer: PREPARE_TIME_SECONDS
    });

    console.log(`[${roomCode}] Pergunta ${room.currentQuestionIndex + 1}`);
    // Inicia a fase de preparação (leitura da pergunta)
    startPrepareTimer(roomCode); 
}

function startPrepareTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'prepare'; // Estado intermediário opcional, ou mantém showingQuestion
    room.timerValue = PREPARE_TIME_SECONDS; 
    
    // Emite o tempo inicial IMEDIATAMENTE para não aparecer zerado
    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'showingQuestion', // Mantém o estado visual de leitura
        timer: room.timerValue,
        // Reenvia dados essenciais caso o cliente precise redesenhar
        questionText: room.questions[room.currentQuestionIndex].text,
        instruction: room.questions[room.currentQuestionIndex].instruction, 
    });

    room.timer = setInterval(() => {
        room.timerValue--;
        if (room.timerValue <= 0) {
            clearInterval(room.timer);
            startAnsweringPhase(roomCode); // Vai para a fase de resposta
        } else {
            // Emite apenas a atualização do timer para economizar banda
            io.to(roomCode).emit('timerUpdate', room.timerValue); 
            // Nota: Se o cliente não tiver um listener específico para 'timerUpdate', 
            // você pode usar gameStateUpdate com apenas o campo timer.
             io.to(roomCode).emit('gameStateUpdate', { 
                 timer: room.timerValue,
                 gameState: 'showingQuestion' // Confirma o estado
             });
        }
    }, 1000);
}

function startAnsweringPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'acceptingAnswers';
    const currentQuestion = room.questions[room.currentQuestionIndex];
    const totalPlayers = room.players.filter(p => p.id !== room.hostId).length;
    
    // Define o tempo da questão baseado nas opções da sala
    const timeLimit = room.gameOptions.questionTime || DEFAULT_QUESTION_TIME;
    room.timerValue = timeLimit;

    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'acceptingAnswers',
        questionData: currentQuestion,
        questionText: currentQuestion.text,
        instruction: currentQuestion.instruction, 
        options: currentQuestion.options,
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        timer: room.timerValue, // Tempo correto
        answeredCount: 0,
        totalPlayers: totalPlayers
    });

    console.log(`[${roomCode}] Valendo! Tempo: ${timeLimit}s`);

    // Timer da fase de resposta
    room.timer = setInterval(() => {
        room.timerValue--;
        if (room.timerValue <= 0) {
            clearInterval(room.timer);
            showResults(roomCode);
        } else {
            io.to(roomCode).emit('timerUpdate', room.timerValue);
            // Fallback compatível
            io.to(roomCode).emit('gameStateUpdate', { 
                 timer: room.timerValue,
                 gameState: 'acceptingAnswers'
             });
        }
    }, 1000);
}

function showResults(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameState === 'showingResults') return;
    if (room.timer) clearInterval(room.timer); // Alterado para clearInterval pois agora usamos setInterval

    room.gameState = 'showingResults';
    const currentQuestion = room.questions[room.currentQuestionIndex];
    
    const correctIndices = Array.isArray(currentQuestion.correctAnswerIndices) 
        ? currentQuestion.correctAnswerIndices 
        : [currentQuestion.correctAnswerIndex]; 

    let roundRanking = [];
    let correctCount = 0;
    let incorrectCount = 0;
    const timeLimit = room.gameOptions.questionTime || DEFAULT_QUESTION_TIME;

    room.players.forEach(player => {
        if (player.id === room.hostId) return;

        let pointsThisRound = 0;
        const playerAnswerData = room.answers[player.id];
        
        let isCorrect = false;

        if (playerAnswerData) {
            const playerIndices = playerAnswerData.answerIndices || []; 
            if (playerIndices.length === correctIndices.length) {
                const allMatch = playerIndices.every(idx => correctIndices.includes(idx));
                if (allMatch) isCorrect = true;
            }
        }

        if (isCorrect) {
            correctCount++;
            player.correctAnswers++;
            
            let speedPoints = 0;
            if (room.gameOptions.scoreType === 'speed') {
                const timeTaken = (playerAnswerData.submissionTime - room.questionStartTime) / 1000;
                // Ajuste no cálculo de tempo para usar o tempo configurado da sala
                const totalTimeAvailable = timeLimit + PREPARE_TIME_SECONDS; 
                const timeRatio = Math.max(0, 1 - (timeTaken / totalTimeAvailable));
                speedPoints = Math.round(POINTS_PER_ANSWER * timeRatio);
            } else { 
                speedPoints = POINTS_PER_ANSWER;
            }

            player.streak++;
            if (player.streak > player.bestStreak) {
                player.bestStreak = player.streak;
            }

            const streakBonusPoints = (player.streak - 1) * STREAK_BONUS;
            pointsThisRound = speedPoints + streakBonusPoints;
            player.score = (player.score || 0) + pointsThisRound;
        } else {
            incorrectCount++;
            player.wrongAnswers++;
            player.streak = 0; 
        }

        roundRanking.push({
            id: player.id,
            nickname: player.nickname,
            pointsThisRound: pointsThisRound,
            totalScore: player.score,
            streak: player.streak,
            bestStreak: player.bestStreak || 0,
            correctAnswers: player.correctAnswers,
            wrongAnswers: player.wrongAnswers
        });
    });
    
    roundRanking.sort((a, b) => b.totalScore - a.totalScore);
    let finalRanking = room.gameOptions.showRanking ? roundRanking : [];

    const results = { 
        correctAnswerIndices: correctIndices, 
        correctCount: correctCount,
        incorrectCount: incorrectCount
    };

    room.players.forEach(player => {
        let playerResult = 'incorrect';
        if (player.id !== room.hostId) {
             const ans = room.answers[player.id];
             if (ans) {
                 const pIndices = ans.answerIndices || [];
                 if (pIndices.length === correctIndices.length && pIndices.every(i => correctIndices.includes(i))) {
                     playerResult = 'correct';
                 }
             }
        }

        let personalPayload = {
            gameState: 'showingResults',
            results: results,
            options: currentQuestion.options,
            ranking: finalRanking,
            showRankingConfig: room.gameOptions.showRanking,
            showExplanationConfig: room.gameOptions.showExplanation,
            questionData: currentQuestion,
            playerResult: playerResult 
        };
        io.to(player.id).emit('gameStateUpdate', personalPayload);
    });
    console.log(`[${roomCode}] Resultados. Acertos: ${correctCount}`);
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    if (room.timer) clearInterval(room.timer); // Limpa qualquer timer pendente

    room.gameState = 'endGame';
    
    const finalRanking = room.players
            .filter(p => p.id !== room.hostId)
            .map(p => ({ ...p, bestStreak: p.bestStreak || 0 })) 
            .sort((a, b) => b.score - a.score);

    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'endGame',
        showRanking: room.gameOptions.showRanking,
        finalRanking: finalRanking,
        playedQuestions: room.questions 
    });
    console.log(`[${roomCode}] Jogo finalizado.`);
}

io.on('connection', (socket) => {
    console.log(`[CONECTADO] Novo socket: ${socket.id}`);
    
    // ... (Bloco de autenticação user:authenticate permanece igual) ...
     socket.on('user:authenticate', async (token) => {
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            socket.uid = decodedToken.uid;
            socket.email = decodedToken.email || null; 
            
            let nicknameToUse = 'Anônimo'; 
            const provider = decodedToken.firebase.sign_in_provider;
            
            if (provider === 'google.com') {
                if (decodedToken.name) {
                    nicknameToUse = decodedToken.name;
                } else if (socket.email) { 
                    nicknameToUse = socket.email.split('@')[0];
                }
            } else if (provider === 'password') {
                if (socket.email) { 
                    nicknameToUse = socket.email.split('@')[0];
                }
            } else if (provider === 'anonymous') {
                nicknameToUse = 'Anônimo';
            } else {
                if (decodedToken.name) {
                    nicknameToUse = decodedToken.name;
                } else if (socket.email) { 
                    nicknameToUse = socket.email.split('@')[0];
                }
            }
            
            socket.nickname = nicknameToUse;
            console.log(`[AUTH] Usuário ${socket.nickname} autenticado.`);
            socket.emit('auth:success', { uid: socket.uid, nickname: socket.nickname });

        } catch (error) {
            console.log(`[AUTH FALHOU] ${error.message}`);
            socket.emit('auth:failed', error.message); 
            socket.disconnect(true);
        }
    });

    // ===== 2. LÓGICA DE CHAT POR TÓPICO (Permanece igual) =====
    socket.on('chat:joinTopic', async (topic) => {
        if (!socket.uid) return; 
        const topicRoomName = `topic_${topic}`;
        socket.join(topicRoomName);
        try {
            const messagesRef = db.collection('chats').doc(topic).collection('messages');
            const snapshot = await messagesRef.orderBy('timestamp', 'desc').limit(50).get();
            if (snapshot.empty) { socket.emit('chat:history', []); return; }
            const history = snapshot.docs.map(doc => doc.data()).reverse(); 
            socket.emit('chat:history', history); 
        } catch (error) { console.log(`[HISTÓRICO ERRO]: ${error.message}`); }
    });

    socket.on('chat:leaveTopic', (topic) => {
        if (!socket.uid) return;
        const topicRoomName = `topic_${topic}`;
        socket.leave(topicRoomName);
    });

    socket.on('chat:sendMessage', async ({ topic, message }) => {
        if (!socket.uid) return; 
        const sanitizedMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} });
        if (sanitizedMessage.trim().length === 0) return; 
        const chatPayload = {
            senderId: socket.uid,
            senderNickname: socket.nickname, 
            senderEmail: socket.email,      
            message: sanitizedMessage,
            topic: topic,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        try {
            const docRef = await db.collection('chats').doc(topic).collection('messages').add(chatPayload);
            const finalPayload = (await docRef.get()).data();
            io.to(`topic_${topic}`).emit('server:newMessage', finalPayload);
        } catch (error) { console.log(`[CHAT DB ERRO]: ${error.message}`); }
    });

    socket.on('createRoom', ({ nickname, gameOptions, customQuestions }) => {
        const gameNickname = nickname || 'Host Anônimo';
        const email = socket.email || null;
        const roomCode = generateRoomCode();

        let questionsToUse = (customQuestions && customQuestions.length > 0) 
                             ? customQuestions 
                             : fallbackQuestions;

        // VALIDAÇÃO E CONFIGURAÇÃO DO GAME OPTIONS
        const options = {
            showRanking: gameOptions ? gameOptions.showRanking !== false : true,
            showExplanation: gameOptions ? gameOptions.showExplanation === true : false, 
            scoreType: gameOptions ? gameOptions.scoreType || 'speed' : 'speed',
            // Adicionado suporte ao tempo personalizado (com fallback)
            questionTime: (gameOptions && gameOptions.questionTime) ? parseInt(gameOptions.questionTime) : DEFAULT_QUESTION_TIME
        };

        rooms[roomCode] = {
            hostId: socket.id,
            players: [{ 
                id: socket.id, 
                nickname: gameNickname, 
                email: email,
                score: 0, 
                streak: 0, 
                correctAnswers: 0,
                wrongAnswers: 0,
                bestStreak: 0 
            }],
            gameState: 'lobby',
            questions: questionsToUse,
            currentQuestionIndex: -1,
            gameOptions: options // Armazena as opções sanitizadas
        };
        socket.join(roomCode);
        
        socket.emit('roomCreated', { 
            roomCode: roomCode, 
            players: rooms[roomCode].players,
            hostId: rooms[roomCode].hostId
        });
        
        console.log(`Sala ${roomCode} criada. Tempo por questão: ${options.questionTime}s`);
    });

    socket.on('joinRoom', ({ roomCode, nickname }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('joinError', 'Código inválido.'); return; }
        if (room.gameState !== 'lobby') { socket.emit('joinError', 'Jogo já começou.'); return; }

        room.players.push({ 
            id: socket.id, 
            nickname: nickname || 'Jogador', 
            email: socket.email || null, 
            score: 0, 
            streak: 0, 
            correctAnswers: 0, 
            wrongAnswers: 0,
            bestStreak: 0 
        });
        socket.join(roomCode);
        socket.emit('joinSuccess', { roomCode: roomCode, players: room.players, hostId: room.hostId });
        socket.to(roomCode).emit('updatePlayerList', room.players);
    });

    socket.on('host:kickPlayer', ({ roomCode, playerIdToKick }) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && playerIdToKick !== socket.id) {
            const socketToKick = io.sockets.sockets.get(playerIdToKick);
            if (socketToKick) {
                socketToKick.emit('kicked', 'Você foi removido da sala pelo Host.');
                socketToKick.leave(roomCode);
            }
            room.players = room.players.filter(p => p.id !== playerIdToKick);
            io.to(roomCode).emit('updatePlayerList', room.players);
            console.log(`[${roomCode}] Host expulsou o jogador ${playerIdToKick}.`);
        }
    });

    // ===== COMANDO DE ENCERRAMENTO FORÇADO =====
    socket.on('host:forceEnd', (roomCode) => { // Alterado para match com o client
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            console.log(`[${roomCode}] Host forçou o fim do jogo.`);
            endGame(roomCode);
        }
    });
    
    socket.on('host:startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            console.log(`[${roomCode}] Host iniciou o jogo.`);
            advanceToNextQuestion(roomCode);
        }
    });

    socket.on('host:nextQuestion', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.gameState === 'showingResults') {
            console.log(`[${roomCode}] Host solicitou próxima questão.`);
            advanceToNextQuestion(roomCode);
        }
    });

    socket.on('guest:submitAnswer', ({ roomCode, answerIndices }) => { 
         const room = rooms[roomCode];
         if (room && room.gameState === 'acceptingAnswers' && !room.answers[socket.id]) {
             room.answers[socket.id] = { answerIndices: answerIndices, submissionTime: Date.now() };
             
             const guestCount = room.players.length - 1;
             if (Object.keys(room.answers).length >= guestCount) showResults(roomCode);
             else {
                 io.to(room.hostId).emit('gameStateUpdate', {
                    gameState: 'acceptingAnswers',
                    answeredCount: Object.keys(room.answers).length,
                    totalPlayers: guestCount,
                    // Reenvia dados contextuais
                    questionData: room.questions[room.currentQuestionIndex], 
                    timer: room.timerValue // Mantém timer sincronizado
                });
             }
         }
    });

    socket.on('host:skipWait', (roomCode) => { if(rooms[roomCode]) showResults(roomCode); });
    
    socket.on('disconnect', () => {
        console.log(`[DESCONECTADO] Usuário com ID: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (socket.id === room.hostId) {
                    if (room.timer) clearInterval(room.timer);
                    io.to(roomCode).emit('error', 'O Host encerrou a sala.');
                    delete rooms[roomCode];
                } else {
                    room.players.splice(playerIndex, 1);
                    io.to(roomCode).emit('updatePlayerList', room.players);
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));