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
    socket.on('createRoom', ({ nickname, gameOptions }) => {
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

    socket.on('client:sendMessage', ({ roomCode, message }) => {
        // 1. Encontrar a sala
        const room = rooms[roomCode];
        if (!room) {
            // Se a sala não existe, não faz nada
            return;
        }

        // 2. Encontrar o jogador que enviou a mensagem (para pegar o nickname)
        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            // Se o jogador não for encontrado
            return;
        }

        // 3. Preparar o payload da mensagem
        const chatPayload = {
            senderId: player.id,
            senderNickname: player.nickname,
            message: message, // ATENÇÃO: Para produção, sanitize esta string!
            timestamp: Date.now()
        };

        // 4. Emitir a mensagem para TODOS na sala (incluindo o remetente)
        io.to(roomCode).emit('server:newMessage', chatPayload);
        
        console.log(`[${roomCode}] Chat: ${player.nickname}: ${message}`);
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