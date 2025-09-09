// server.js (VERSÃO COM MÚLTIPLAS QUESTÕES)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

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
            const timeTaken = (playerAnswerData.submissionTime - room.questionStartTime) / 1000;
            // O tempo total agora é o tempo da pergunta + o tempo de "prepare-se"
            const totalTimeAvailable = QUESTION_TIME_SECONDS + PREPARE_TIME_SECONDS; 
            const timeRatio = Math.max(0, 1 - (timeTaken / totalTimeAvailable));
            const speedPoints = Math.round(POINTS_PER_ANSWER * timeRatio);

            player.streak++;
            const streakBonusPoints = (player.streak - 1) * STREAK_BONUS;
            pointsThisRound = speedPoints + streakBonusPoints;
            player.score = (player.score || 0) + pointsThisRound;
        } else {
            incorrectCount++;
            player.streak = 0;
        }

        roundRanking.push({
            id: player.id,
            nickname: player.nickname,
            pointsThisRound: pointsThisRound,
            totalScore: player.score,
        });
    });

    roundRanking.sort((a, b) => b.totalScore - a.totalScore);
    
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
            ranking: roundRanking
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
    // ... createRoom e joinRoom (sem mudanças)
    socket.on('createRoom', (nickname) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            hostId: socket.id,
            players: [{ id: socket.id, nickname: nickname, score: 0, streak: 0 }],
            gameState: 'lobby',
            // NOVO: Adiciona as questões e o índice à sala
            questions: gameQuestions, // Em um app real, isso viria das opções do host
            currentQuestionIndex: -1 // Começa em -1 para que o primeiro incremento seja 0
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    socket.on('joinRoom', ({ roomCode, nickname }) => {
        const room = rooms[roomCode];

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
        room.players.push({ id: socket.id, nickname: nickname, score: 0, streak: 0 });
        socket.join(roomCode);
        
        // Responde APENAS ao jogador com uma confirmação de sucesso
        socket.emit('joinSuccess', { 
            roomCode: roomCode, 
            players: room.players 
        });
        
        // Avisa a TODOS OS OUTROS jogadores na sala que um novo jogador entrou
        socket.to(roomCode).emit('updatePlayerList', room.players);
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
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (socket.id === room.hostId) {
                    // Se o host desconectar, encerra o jogo e avisa a todos
                    if (room.timer) clearTimeout(room.timer);
                    io.to(roomCode).emit('error', 'O Host encerrou a sala.');
                    delete rooms[roomCode];
                } else {
                    // Se um guest sair, apenas atualiza a lista
                    room.players.splice(playerIndex, 1);
                    io.to(roomCode).emit('updatePlayerList', room.players);
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));