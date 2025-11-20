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
const QUESTION_TIME_SECONDS = 30;
const PREPARE_TIME_SECONDS = 5;

// Perguntas de fallback caso o host não envie nada (apenas para teste)
const fallbackQuestions = [
    {
        text: "Aguardando o Host configurar as questões...",
        options: ["..."],
        correctAnswerIndex: 0,
        syllogism: {}
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

    // Envia o objeto completo da questão (questionData) para o cliente renderizar silogismos
    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'showingQuestion',
        questionData: currentQuestion, // O cliente usa isso para mostrar premissas
        questionText: currentQuestion.text, // Fallback simples
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        timer: PREPARE_TIME_SECONDS
    });

    console.log(`[${roomCode}] Mostrando pergunta ${room.currentQuestionIndex + 1}`);
    room.timer = setTimeout(() => startAnsweringPhase(roomCode), PREPARE_TIME_SECONDS * 1000);
}

function startAnsweringPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'acceptingAnswers';
    const currentQuestion = room.questions[room.currentQuestionIndex];
    const totalPlayers = room.players.filter(p => p.id !== room.hostId).length;
    
    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'acceptingAnswers',
        questionData: currentQuestion,
        questionText: currentQuestion.text,
        options: currentQuestion.options,
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        timer: QUESTION_TIME_SECONDS,
        answeredCount: 0,
        totalPlayers: totalPlayers
    });

    console.log(`[${roomCode}] Aceitando respostas por ${QUESTION_TIME_SECONDS}s.`);
    room.timer = setTimeout(() => showResults(roomCode), QUESTION_TIME_SECONDS * 1000);
}

function showResults(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameState === 'showingResults') return;
    if (room.timer) clearTimeout(room.timer);

    room.gameState = 'showingResults';
    const currentQuestion = room.questions[room.currentQuestionIndex];

    let roundRanking = [];
    let correctCount = 0;
    let incorrectCount = 0;

    room.players.forEach(player => {
        if (player.id === room.hostId) return;

        let pointsThisRound = 0;
        const playerAnswerData = room.answers[player.id];

        if (playerAnswerData && playerAnswerData.answerIndex === currentQuestion.correctAnswerIndex) {
            correctCount++;
            player.correctAnswers++;
            
            let speedPoints = 0;
            if (room.gameOptions.scoreType === 'speed') {
                const timeTaken = (playerAnswerData.submissionTime - room.questionStartTime) / 1000;
                const totalTimeAvailable = QUESTION_TIME_SECONDS + 5;
                const timeRatio = Math.max(0, 1 - (timeTaken / totalTimeAvailable));
                speedPoints = Math.round(POINTS_PER_ANSWER * timeRatio);
            } else { 
                speedPoints = POINTS_PER_ANSWER;
            }

            player.streak++;
            // CORREÇÃO: Lógica de Best Streak
            if (player.streak > player.bestStreak) {
                player.bestStreak = player.streak;
            }

            const streakBonusPoints = (player.streak - 1) * STREAK_BONUS;
            pointsThisRound = speedPoints + streakBonusPoints;
            player.score = (player.score || 0) + pointsThisRound;
        } else {
            incorrectCount++;
            player.wrongAnswers++;
            player.streak = 0; // Reseta o streak atual
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
    let finalRanking = roundRanking;

    if(!room.gameOptions.showRanking){
        finalRanking = [];
    }
    
    const results = { 
        correctAnswerIndex: currentQuestion.correctAnswerIndex,
        correctCount: correctCount,
        incorrectCount: incorrectCount
    };

    room.players.forEach(player => {
        let personalPayload = {
            gameState: 'showingResults',
            results: results,
            options: currentQuestion.options,
            ranking: finalRanking,
            // Envia as opções de visualização para o cliente
            showRankingConfig: room.gameOptions.showRanking,
            showExplanationConfig: room.gameOptions.showExplanation,
            questionData: currentQuestion // Envia dados da questão para mostrar a explicação
        };
        if (player.id !== room.hostId) {
            const playerAnswerData = room.answers[player.id];
            personalPayload.playerResult = (playerAnswerData && playerAnswerData.answerIndex === currentQuestion.correctAnswerIndex) ? 'correct' : 'incorrect';
        }
        io.to(player.id).emit('gameStateUpdate', personalPayload);
    });
    console.log(`[${roomCode}] Mostrando resultados.`);
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
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
    socket.on('user:authenticate', async (token) => {
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            socket.uid = decodedToken.uid;
            
            // ** ARMAZENA O EMAIL COMPLETO NO SOCKET **
            socket.email = decodedToken.email || null; // Guarda o email completo
            
            // LÓGICA DE PRIORIDADE DO NICKNAME (PARA EXIBIÇÃO)
            let nicknameToUse = 'Anônimo'; // Fallback
            const provider = decodedToken.firebase.sign_in_provider;
            
            if (provider === 'google.com') {
                // Login Google: Prioriza nome do Google, senão parte antes do @ do email
                if (decodedToken.name) {
                    nicknameToUse = decodedToken.name;
                } else if (socket.email) { // Usa o email armazenado
                    nicknameToUse = socket.email.split('@')[0];
                }
            } else if (provider === 'password') {
                // Login Email/Senha: Usa parte antes do @ do email
                if (socket.email) { // Usa o email armazenado
                    nicknameToUse = socket.email.split('@')[0];
                }
            } else if (provider === 'anonymous') {
                nicknameToUse = 'Anônimo';
            } 
            else {
                // Outros logins: Tenta nome, senão parte antes do @ do email
                if (decodedToken.name) {
                    nicknameToUse = decodedToken.name;
                } else if (socket.email) { // Usa o email armazenado
                    nicknameToUse = socket.email.split('@')[0];
                }
            }
            
            // Armazena o NICKNAME (para exibição) no socket
            socket.nickname = nicknameToUse;
            
            // ==========================================

            console.log(`[AUTH] Usuário ${socket.nickname} (Email: ${socket.email || 'N/A'}, UID: ${socket.uid}) autenticado.`);
            
            // Envia o nickname para o cliente (não precisa enviar o email)
            socket.emit('auth:success', { uid: socket.uid, nickname: socket.nickname });

        } catch (error) {
            console.log(`[AUTH FALHOU] ${error.message}`);
            socket.emit('auth:failed', error.message); 
            socket.disconnect(true);
        }
    });

    // ===== 2. LÓGICA DE CHAT POR TÓPICO =====
    socket.on('chat:joinTopic', async (topic) => {
        if (!socket.uid) return; // Ignore se não estiver autenticado

        const topicRoomName = `topic_${topic}`;
        socket.join(topicRoomName);
        console.log(`[CHAT] ${socket.nickname} entrou no tópico: ${topic}`);

        // ** CARREGAR HISTÓRICO **
        try {
            const messagesRef = db.collection('chats').doc(topic).collection('messages');
            const snapshot = await messagesRef.orderBy('timestamp', 'desc').limit(50).get();

            if (snapshot.empty) {
                socket.emit('chat:history', []); // Envia histórico vazio
                return;
            }

            const history = snapshot.docs.map(doc => doc.data()).reverse(); // Inverte para ordem cronológica
            socket.emit('chat:history', history); // Envia o histórico SÓ PARA ESTE USUÁRIO

        } catch (error) {
            console.log(`[HISTÓRICO ERRO] Falha ao buscar histórico: ${error.message}`);
        }
    });

    socket.on('chat:leaveTopic', (topic) => {
        if (!socket.uid) return;
        const topicRoomName = `topic_${topic}`;
        socket.leave(topicRoomName);
        console.log(`[CHAT] ${socket.nickname} saiu do tópico: ${topic}`);
    });

    socket.on('chat:sendMessage', async ({ topic, message }) => {
        if (!socket.uid) return; // Não autenticado

        // ** 1. SANITIZAR A MENSAGEM (SEGURANÇA) **
        const sanitizedMessage = sanitizeHtml(message, {
            allowedTags: [], // Remove TODAS as tags HTML
            allowedAttributes: {}
        });

        if (sanitizedMessage.trim().length === 0) return; // Ignora mensagens vazias

        // ** 2. PREPARAR O PAYLOAD **
        const chatPayload = {
            senderId: socket.uid,
            senderNickname: socket.nickname, // Nickname para exibição
            senderEmail: socket.email,      // Email completo para armazenamento
            message: sanitizedMessage,
            topic: topic,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };

        // ** 3. SALVAR NO FIREBASE **
        try {
            const docRef = await db.collection('chats').doc(topic).collection('messages').add(chatPayload);
            console.log(`[CHAT DB] Mensagem ${docRef.id} salva.`);

            // ** 4. TRANSMITIR PARA A SALA **
            // (Precisamos ler o documento salvo para obter o timestamp real)
            const finalPayload = (await docRef.get()).data();
            io.to(`topic_${topic}`).emit('server:newMessage', finalPayload);

        } catch (error) {
            console.log(`[CHAT DB ERRO] Falha ao salvar mensagem: ${error.message}`);
        }
    });

    socket.on('user:setNickname', (nickname) => {
        // Armazena o nickname no próprio socket para uso posterior
        socket.nickname = nickname; 
        console.log(`[CONECTADO] Usuário ${socket.id} definiu o nickname como: ${nickname}`);
    });

    socket.on('createRoom', ({ nickname, gameOptions, customQuestions }) => {
        const gameNickname = nickname || 'Host Anônimo';
        const email = socket.email || null;
        const roomCode = generateRoomCode();

        // Define as questões: Usa as customizadas se enviadas, senão fallback
        let questionsToUse = (customQuestions && customQuestions.length > 0) 
                             ? customQuestions 
                             : fallbackQuestions;

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
                bestStreak: 0 // CORREÇÃO: Inicialização explícita
            }],
            gameState: 'lobby',
            questions: questionsToUse,
            currentQuestionIndex: -1,
            gameOptions: {
                showRanking: gameOptions ? gameOptions.showRanking !== false : true,
                // NOVA OPÇÃO: Mostrar explicação
                showExplanation: gameOptions ? gameOptions.showExplanation === true : false, 
                scoreType: gameOptions ? gameOptions.scoreType || 'speed' : 'speed'
            }
        };
        socket.join(roomCode);
        
        socket.emit('roomCreated', { 
            roomCode: roomCode, 
            players: rooms[roomCode].players,
            hostId: rooms[roomCode].hostId
        });
        
        console.log(`Sala ${roomCode} criada. Questões: ${questionsToUse.length}`);
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
            bestStreak: 0 // CORREÇÃO: Inicialização explícita
        });
        socket.join(roomCode);
        socket.emit('joinSuccess', { roomCode: roomCode, players: room.players, hostId: room.hostId });
        socket.to(roomCode).emit('updatePlayerList', room.players);
    });

    // ===== NOVO EVENTO: host:kickPlayer =====
    socket.on('host:kickPlayer', ({ roomCode, playerIdToKick }) => {
        const room = rooms[roomCode];
        // Garante que apenas o host pode expulsar e que ele não expulse a si mesmo
        if (room && room.hostId === socket.id && playerIdToKick !== socket.id) {
            
            // Encontra o socket do jogador a ser expulso
            const socketToKick = io.sockets.sockets.get(playerIdToKick);
            if (socketToKick) {
                // Envia uma mensagem para o jogador expulso
                socketToKick.emit('kicked', 'Você foi removido da sala pelo Host.');
                // Força a desconexão dele da sala
                socketToKick.leave(roomCode);
            }
            
            // Remove o jogador da lista da sala
            room.players = room.players.filter(p => p.id !== playerIdToKick);
            
            // Atualiza a lista de jogadores para todos que permaneceram na sala
            io.to(roomCode).emit('updatePlayerList', room.players);
            
            console.log(`[${roomCode}] Host expulsou o jogador ${playerIdToKick}.`);
        }
    });
    
    // ===== EVENTOS DE JOGO ATUALIZADOS =====
    socket.on('host:startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            console.log(`[${roomCode}] Host iniciou o jogo.`);
            // A função advanceToNextQuestion agora inicia e continua o jogo
            advanceToNextQuestion(roomCode);
        }
    });

    // NOVO EVENTO para avançar para a próxima questão
    socket.on('host:nextQuestion', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.gameState === 'showingResults') {
            console.log(`[${roomCode}] Host solicitou próxima questão.`);
            advanceToNextQuestion(roomCode);
        }
    });

    socket.on('guest:submitAnswer', ({ roomCode, answerIndex }) => {
         const room = rooms[roomCode];
         if (room && room.gameState === 'acceptingAnswers' && !room.answers[socket.id]) {
             room.answers[socket.id] = { answerIndex: answerIndex, submissionTime: Date.now() };
             // ... lógica de contagem e auto-avanço ...
             const guestCount = room.players.length - 1;
             if (Object.keys(room.answers).length >= guestCount) showResults(roomCode);
             else {
                // Atualiza contador para host
                 io.to(room.hostId).emit('gameStateUpdate', {
                    gameState: 'acceptingAnswers',
                    answeredCount: Object.keys(room.answers).length,
                    totalPlayers: guestCount,
                    // Mantém dados consistentes
                    questionText: room.questions[room.currentQuestionIndex].text,
                    questionData: room.questions[room.currentQuestionIndex], 
                    options: room.questions[room.currentQuestionIndex].options,
                    questionIndex: room.currentQuestionIndex,
                    totalQuestions: room.questions.length
                });
             }
         }
    });
    socket.on('host:skipWait', (roomCode) => { if(rooms[roomCode]) showResults(roomCode); });
    
    socket.on('disconnect', () => {
        console.log(`[DESCONECTADO] Usuário com ID: ${socket.id}`);
        // Lógica de disconnect das salas de JOGO
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (socket.id === room.hostId) {
                    if (room.timer) clearTimeout(room.timer);
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