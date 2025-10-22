// server.js (VERSÃO COM MÚLTIPLAS QUESTÕES)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const admin = require('firebase-admin');
const sanitizeHtml = require('sanitize-html');
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // 1. Está rodando no Render
  console.log("Carregando credenciais do Firebase a partir do Environment Variable...");
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // 2. Está rodando localmente
  console.log("Carregando credenciais do Firebase a partir do arquivo service-account-key.json local...");
  // Este arquivo NÃO PODE ESTAR NO GITHUB.
  // Certifique-se que 'service-account-key.json' está no seu .gitignore
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

const POINTS_PER_ANSWER = 1000; // Pontos máximos por resposta
const STREAK_BONUS = 20;       // Bônus por cada acerto em sequência
const QUESTION_TIME_SECONDS = 30;
const PREPARE_TIME_SECONDS = 5;

// ===== NOVO: LISTA DE PERGUNTAS DE EXEMPLO =====
const gameQuestions = [
    {
        text: "Qual destes planetas é conhecido como 'Planeta Vermelho'?",
        options: ["Vênus", "Marte", "Júpiter", "Saturno"],
        correctAnswerIndex: 1
    },
    {
        text: "Qual é o maior oceano da Terra?",
        options: ["Atlântico", "Índico", "Ártico", "Pacífico"],
        correctAnswerIndex: 3
    },
    {
        text: "Qual é a capital da Austrália?",
        options: ["Sydney", "Melbourne", "Canberra", "Perth"],
        correctAnswerIndex: 2
    }
];
// ==============================================

function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ===== LÓGICA DO JOGO REFEITA =====
function advanceToNextQuestion(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentQuestionIndex++; // Avança para a próxima questão
    
    // Verifica se o jogo acabou
    if (room.currentQuestionIndex >= room.questions.length) {
        endGame(roomCode);
        return;
    }

    room.gameState = 'showingQuestion';
    room.answers = {}; // Limpa as respostas da rodada
    room.questionStartTime = Date.now();
    const currentQuestion = room.questions[room.currentQuestionIndex];

    // Fase 1: Mostrar a pergunta por 5 segundos
    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'showingQuestion',
        questionText: currentQuestion.text,
        questionIndex: room.currentQuestionIndex, // Envia o índice atual
        totalQuestions: room.questions.length,   // Envia o total
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
    
    // Fase 2: Aceitar respostas por 30 segundos
    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'acceptingAnswers',
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
        
        // CORREÇÃO DEFENSIVA: Garante que as variáveis de tempo são números.
        

        if (playerAnswerData && playerAnswerData.answerIndex === currentQuestion.correctAnswerIndex) {
            correctCount++;
            player.correctAnswers++;
            let speedPoints = 0;
            if (room.gameOptions.scoreType === 'speed') {
                // Cálculo por velocidade (o que já tínhamos)
                const timeTaken = (playerAnswerData.submissionTime - room.questionStartTime) / 1000;
                const totalTimeAvailable = QUESTION_TIME_SECONDS + 5;
                const timeRatio = Math.max(0, 1 - (timeTaken / totalTimeAvailable));
                speedPoints = Math.round(POINTS_PER_ANSWER * timeRatio);
            } else { // scoreType === 'correct'
                // Pontos fixos por acerto
                speedPoints = POINTS_PER_ANSWER;
            }

            player.streak++;
            if (player.streak > player.bestStreak) player.bestStreak = player.streak;
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
    let finalRanking = roundRanking;

    if(!room.gameOptions.showRanking){
        finalRanking = [];
    }
    
    const results = { 
        correctAnswerIndex: currentQuestion.correctAnswerIndex,
        correctCount: correctCount,
        incorrectCount: incorrectCount
    };

    // Lógica para enviar payload personalizado (sem mudanças)
    room.players.forEach(player => {
        let personalPayload = {
            gameState: 'showingResults',
            results: results,
            options: currentQuestion.options,
            ranking: finalRanking
        };
        if (player.id !== room.hostId) {
            const playerAnswerData = room.answers[player.id];
            personalPayload.playerResult = (playerAnswerData && playerAnswerData.answerIndex === currentQuestion.correctAnswerIndex) ? 'correct' : 'incorrect';
        }
        io.to(player.id).emit('gameStateUpdate', personalPayload);
    });
    console.log(`[${roomCode}] Mostrando resultados. Acertos: ${correctCount}, Erros: ${incorrectCount}`);
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState = 'endGame';
    
    const finalRanking = room.players
        .filter(p => p.id !== room.hostId)
        .sort((a, b) => b.score - a.score);

    io.to(roomCode).emit('gameStateUpdate', {
        gameState: 'endGame',
        // MUDANÇA: Envia o ranking completo em vez de apenas o pódio
        finalRanking: finalRanking 
    });
    console.log(`[${roomCode}] Jogo finalizado.`);
}
// ======================================

io.on('connection', (socket) => {
    console.log(`[CONECTADO] Novo socket: ${socket.id}`);
    // ===== 1. AUTENTICAÇÃO DO USUÁRIO =====
    // O Flutter enviará o token do Firebase após a conexão
    socket.on('user:authenticate', async (token) => {
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            socket.uid = decodedToken.uid; 
            socket.nickname = decodedToken.name || 'Anônimo';
            console.log(`[AUTH] Usuário ${socket.nickname} (UID: ${socket.uid}) autenticado.`);
            
            // ===== ADICIONE ESTA LINHA =====
            // Envia a confirmação e o nickname de volta para o cliente
            socket.emit('auth:success', { uid: socket.uid, nickname: socket.nickname });
            // ================================

        } catch (error) {
            console.log(`[AUTH FALHOU] ${error.message}`);
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
            senderId: socket.uid, // UID seguro do Firebase
            senderNickname: socket.nickname, // Nickname seguro do token
            message: sanitizedMessage,
            topic: topic,
            timestamp: admin.firestore.FieldValue.serverTimestamp() // Timestamp do servidor
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

    socket.on('createRoom', ({ gameOptions }) => {
        const nickname = socket.nickname || 'Host Anonimo';
        console.log(`Host criando sala com nickname: ${nickname}`); // Log para confirmar

        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            hostId: socket.id,
            
            // CORREÇÃO: Usamos a variável 'nickname' (que é uma String) para criar o jogador Host.
            players: [{ 
                id: socket.id, 
                nickname: nickname, 
                score: 0, 
                streak: 0, 
                correctAnswers: 0,
                wrongAnswers: 0
            }],
            
            gameState: 'lobby',
            questions: gameQuestions,
            currentQuestionIndex: -1,
            gameOptions: {
                // Lógica defensiva para definir os valores padrão
                showRanking: gameOptions ? gameOptions.showRanking !== false : true,
                scoreType: gameOptions ? gameOptions.scoreType || 'speed' : 'speed'
            }
        };
        socket.join(roomCode);
        
        // Envia a resposta para o Host com o ID do Host incluído
        socket.emit('roomCreated', { 
            roomCode: roomCode, 
            players: rooms[roomCode].players,
            hostId: rooms[roomCode].hostId
        });
        
        console.log(`Sala ${roomCode} criada pelo Host ${nickname}.`);
        console.log(`[DEBUG] Criada sala ${roomCode} com hostId = ${rooms[roomCode].hostId}`);
    });

    socket.on('joinRoom', ({ roomCode }) => {
        const room = rooms[roomCode];
        const nickname = socket.nickname || 'Jogador Anonimo';

        // Caso 1: Sala não existe
        if (!room) {
            // Responde APENAS ao jogador que tentou entrar com um erro específico
            socket.emit('joinError', 'Código da sala inválido.');
            return;
        }

        // Caso 2: Jogo já começou
        if (room.gameState !== 'lobby') {
            socket.emit('joinError', 'Este jogo já começou. Não é possível entrar.');
            return;
        }

        // Caso 3: Sucesso!
        room.players.push({ id: socket.id, nickname: nickname, score: 0, streak: 0, correctAnswers: 0, wrongAnswers: 0 });
        socket.join(roomCode);
        
        // Responde APENAS ao jogador com uma confirmação de sucesso
        socket.emit('joinSuccess', { 
            roomCode: roomCode, 
            players: room.players,
            hostId: room.hostId // ENVIA O ID DO HOST
        });
        
        // Avisa a TODOS OS OUTROS jogadores na sala que um novo jogador entrou
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
        // Garante que a mesma pessoa não responda duas vezes
        if (room && room.gameState === 'acceptingAnswers' && !room.answers[socket.id]) {
            room.answers[socket.id] = { answerIndex: answerIndex, submissionTime: Date.now() };

            const guestCount = room.players.length - 1;
            const answersCount = Object.keys(room.answers).length;
            const currentQuestion = room.questions[room.currentQuestionIndex];

            // NOVA FEATURE: Envia uma atualização do contador APENAS para o host
            io.to(room.hostId).emit('gameStateUpdate', {
                gameState: 'acceptingAnswers', // Mantém o mesmo estado
                answeredCount: answersCount,
                totalPlayers: guestCount,
                questionText: currentQuestion.text,
                options: currentQuestion.options, // Mesmo que o host não mostre, é bom para consistência
                questionIndex: room.currentQuestionIndex,
                totalQuestions: room.questions.length
            });

            console.log(`[${roomCode}] Resposta recebida. ${answersCount}/${guestCount} responderam.`);

            if (answersCount >= guestCount) {
                showResults(roomCode);
            }
        }
    });

    socket.on('host:skipWait', (roomCode) => {
        const room = rooms[roomCode];
        // Garante que apenas o host pode pular e apenas durante a fase de respostas
        if (room && room.hostId === socket.id && room.gameState === 'acceptingAnswers') {
            console.log(`[${roomCode}] Host pulou a espera.`);
            showResults(roomCode); // Chama a função de resultados imediatamente
        }
    });
    
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