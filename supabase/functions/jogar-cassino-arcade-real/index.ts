import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const defaultStakes = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const gameStakes: Record<string, number[]> = {
  bingo_real: [100, 200, 300, 400, 500, 1000, 2000, 3000, 4000, 5000, 10000, 20000],
  crash_vegas_real: Array.from({ length: 100 }, (_, i) => (i + 1) * 100),
  plinko_neon_real: Array.from({ length: 100 }, (_, i) => (i + 1) * 100),
  neon_pinball_real: [50, 100, 200, 500, 1000, 2000, 3000],
  eight_ball_real: [1000, 2000, 3000, 4000, 5000],
};
const reds = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function rand(n: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0x100000000) throw new Error("Invalid random range");
  const range = 0x100000000;
  const limit = Math.floor(range / n) * n;
  const b = new Uint32Array(1);
  do { crypto.getRandomValues(b); } while (b[0] >= limit);
  return b[0] % n;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) return reply({ error: "Configuração do servidor incompleta." }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return reply({ error: "Entre na sua conta antes de jogar." }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth.user) return reply({ error: "Sessão inválida. Entre novamente." }, 401);
    const body = await req.json().catch(() => null);
    const testMode = body?.test_mode === true;
    if (!testMode && Deno.env.get("CASSINO_REAL_MONEY_ENABLED") !== "true") {
      return reply({ error: "Apostas em dinheiro real estão bloqueadas no servidor. A carteira não foi debitada." }, 423);
    }
    if (testMode && !["66b95d54-d754-46ba-afbc-fa713c61e8df", "68be2506-c1e9-484c-853d-015afadbd21a"].includes(auth.user.id)) return reply({ error: "Modo de teste não autorizado." }, 403);
    const game = String(body?.game ?? "");
    const stake = Number(body?.stake_cents);
    if (!["mega_slots_real", "roulette_real", "fortune_wheel_real", "neon_pinball_real", "eight_ball_real", "neon_target_real", "bingo_real", "crash_vegas_real", "plinko_neon_real"].includes(game)) return reply({ error: "Jogo não suportado." }, 400);
    const allowedStakes = gameStakes[game] ?? defaultStakes;
    if (game === "bingo_real") {
      if (!Number.isInteger(stake) || stake < 100 || stake > 2000000 || stake % 100 !== 0) return reply({ error: "Valor total de aposta inválido para o bingo." }, 400);
    } else if (!Number.isInteger(stake) || !allowedStakes.includes(stake)) {
      return reply({ error: "Valor de aposta inválido para este jogo." }, 400);
    }
    // Pinball e sinuca usam um resultado de aposta definido exclusivamente pelo servidor.
    // A animação/mesa no navegador é visual e não influencia o prêmio; isso é informado na interface.
    // Checagem explícita da carteira real no servidor antes de gerar qualquer resultado.
    // A RPC de liquidação verifica novamente o saldo com bloqueio de linha, evitando corrida.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: wallet, error: walletError } = testMode ? { data: null, error: null } : await admin
      .from("wallets")
      .select("balance")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (walletError) {
      console.error("Wallet precheck failed", walletError.message);
      return reply({ error: "Não foi possível confirmar o saldo real. Tente novamente." }, 503);
    }
    if (!testMode && (!wallet || Number(wallet.balance) < stake / 100)) {
      return reply({ error: "Saldo real insuficiente para essa aposta." }, 409);
    }

    let payout = 0;
    let result: Record<string, unknown> = {};
    if (game === "bingo_real") {
      const selectedRaw = body?.selected_numbers;
      const selectedNumbers = Array.isArray(selectedRaw) ? [...new Set(selectedRaw.map(Number))] : [Number(body?.selected_number)];
      const perNumberStake = Number(body?.per_number_stake_cents ?? stake);
      const allowedPerNumber = [100,200,300,400,500,1000,2000,3000,4000,5000,10000,20000];
      if (!selectedNumbers.length || selectedNumbers.length > 100 || selectedNumbers.some(n => !Number.isInteger(n) || n < 1 || n > 100)) return reply({ error: "Escolha de 1 a 100 números válidos." }, 400);
      if (!Number.isInteger(perNumberStake) || !allowedPerNumber.includes(perNumberStake)) return reply({ error: "Valor por número inválido." }, 400);
      if (stake !== perNumberStake * selectedNumbers.length) return reply({ error: "O total da aposta não corresponde aos números selecionados." }, 400);
      const drawn = rand(100) + 1;
      const won = selectedNumbers.includes(drawn);
      const multiplier = won ? 100 : 0;
      payout = won ? perNumberStake * multiplier : 0;
      result = { selected_numbers: selectedNumbers, drawn_number: drawn, outcome: won ? "BINGO! VOCÊ ACERTOU!" : "NÃO FOI DESTA VEZ", multiplier, won, per_number_stake_cents: perNumberStake, total_stake_cents: stake };
    } else if (game === "mega_slots_real") {
      const symbols = ["🍒", "🍋", "🔔", "💎", "7️⃣", "⭐", "🍀"];
      const grid = Array.from({length:3}, () => Array.from({length:3}, () => symbols[rand(symbols.length)]));
      // Regra do cassino: qualquer fileira horizontal com 3 símbolos iguais paga 2x a aposta total.
      // O prêmio é concedido uma única vez, mesmo que duas ou três fileiras combinem.
      const winningRows = grid.map((row, index) => row.every(v => v === row[0]) ? index : -1).filter(index => index >= 0);
      const won = winningRows.length > 0;
      const multiplier = won ? 2 : 0;
      payout = stake * multiplier;
      result = { grid, multiplier, won, winning_rows: winningRows, outcome: won ? "COMBINAÇÃO PREMIADA" : "SEM COMBINAÇÃO" };
    } else if (game === "crash_vegas_real") {
      // Resultado final e prêmio definidos no servidor; a animação do cliente é apenas apresentação.
      const outcomes = [
        { endpoint: 1.00, multiplier: 0, weight: 50 },
        { endpoint: 1.20, multiplier: 1.2, weight: 20 },
        { endpoint: 1.50, multiplier: 1.5, weight: 15 },
        { endpoint: 2.00, multiplier: 2, weight: 8 },
        { endpoint: 3.00, multiplier: 3, weight: 5 },
        { endpoint: 5.00, multiplier: 5, weight: 2 },
      ];
      const roll = rand(100);
      let cumulative = 0;
      const chosen = outcomes.find(item => { cumulative += item.weight; return roll < cumulative; })!;
      payout = Math.round(stake * chosen.multiplier);
      result = { crash_multiplier: chosen.endpoint, multiplier: chosen.multiplier, outcome: chosen.multiplier > 0 ? "MULTIPLICADOR PREMIADO" : "CRASH" };
    } else if (game === "plinko_neon_real") {
      // 8 rows: the server-generated left/right path determines the exact landing bin.
      // The client animates this same path; it cannot choose or alter the result.
      const path = Array.from({ length: 8 }, () => rand(2)); // 0 = left, 1 = right
      const binIndex = path.reduce((sum, direction) => sum + direction, 0);
      const paytable = [5, 2, 1.2, 0.8, 0.5, 0.8, 1.2, 2, 5];
      const multiplier = paytable[binIndex];
      payout = Math.round(stake * multiplier);
      result = { path, rows: 8, bin_index: binIndex, multiplier, outcome: "PLINKO DROP" };
    } else if (game === "roulette_real") {
      const type = String(body?.bet_type ?? "");
      const value = String(body?.bet_value ?? "");
      if (!["number","color","parity","range","dozen"].includes(type)) return reply({error:"Aposta de roleta inválida."},400);
      const n = rand(37);
      const color = n === 0 ? "verde" : reds.has(n) ? "vermelho" : "preto";
      let mult = 0;
      if (type === "number") { if (!/^([0-9]|[12][0-9]|3[0-6])$/.test(value)) return reply({error:"Número inválido."},400); if (n === Number(value)) mult = 36; }
      if (type === "color") { if (!["vermelho","preto","verde"].includes(value)) return reply({error:"Cor inválida."},400); if (color === value) mult = value === "verde" ? 36 : 2; }
      if (type === "parity") { if (!["par","ímpar"].includes(value)) return reply({error:"Paridade inválida."},400); if (n !== 0 && (n%2===0?"par":"ímpar")===value) mult=2; }
      if (type === "range") { if (!["baixo","alto"].includes(value)) return reply({error:"Faixa inválida."},400); if (n!==0 && (n<=18?"baixo":"alto")===value) mult=2; }
      if (type === "dozen") { const d={"1ª dúzia":1,"2ª dúzia":2,"3ª dúzia":3}[value as "1ª dúzia"|"2ª dúzia"|"3ª dúzia"]; if (!d) return reply({error:"Dúzia inválida."},400); if(n!==0 && Math.ceil(n/12)===d) mult=3; }
      payout = stake * mult;
      result = { number:n, color, bet_type:type, bet_value:value, multiplier:mult };
    } else if (game === "fortune_wheel_real") {
      const prizes = [0, 0.5, 1, 2, 3, 5];
      const chosen = rand(prizes.length);
      const multiplier = prizes[chosen];
      payout = Math.round(stake * multiplier);
      result = { prize_multiplier: multiplier, prize_index: chosen };
    } else if (game === "neon_pinball_real") {
      // Server decides the round result; client score cannot influence the payout.
      const outcomes = [{label:"BOLA PERDIDA",multiplier:0},{label:"JOGO RÁPIDO",multiplier:0.5},{label:"BONUS NEON",multiplier:1},{label:"MULTIPLICADOR VEGAS",multiplier:2},{label:"JACKPOT PINBALL",multiplier:5}];
      const chosen = rand(outcomes.length);
      payout = Math.round(stake * outcomes[chosen].multiplier);
      result = { outcome: outcomes[chosen].label, multiplier: outcomes[chosen].multiplier };
    } else if (game === "eight_ball_real") {
      // Server decides win/loss, never trusts client-side pool physics or score.
      const won = rand(2) === 1;
      const multiplier = won ? 2 : 0;
      payout = stake * multiplier;
      result = { outcome: won ? "VITÓRIA" : "DERROTA", multiplier };
    } else if (game === "neon_target_real") {
      // Server determines hits and payout independently of client coordinates/score.
      const outcomes = [{label:"NENHUM ACERTO",multiplier:0},{label:"ANEL EXTERNO",multiplier:0.5},{label:"ANEL INTERNO",multiplier:1},{label:"ALVO PERFEITO",multiplier:2},{label:"BULLSEYE NEON",multiplier:5}];
      const chosen = rand(outcomes.length);
      payout = Math.round(stake * outcomes[chosen].multiplier);
      result = { outcome: outcomes[chosen].label, multiplier: outcomes[chosen].multiplier };
    }
    const roundId = crypto.randomUUID();
    if (testMode) {
      const { data: testData, error: testError } = await admin.rpc("settle_cassino_test_round", { p_user_id: auth.user.id, p_round_id: roundId, p_game_key: game, p_stake_cents: stake, p_payout_cents: payout, p_result: result });
      if (testError) return reply({ error: /Insufficient test balance/i.test(testError.message) ? "Saldo de teste insuficiente." : "Não foi possível finalizar a rodada de teste." }, 409);
      return reply({ ...testData, game, balance: testData.balance, payout: payout / 100, result, test_mode: true });
    }
    const { data, error } = await admin.rpc("settle_cassino_arcade_round", {
      p_user_id: auth.user.id, p_round_id: roundId, p_game_key: game,
      p_stake_cents: stake, p_payout_cents: payout, p_result: result,
    });
    if (error) {
      if (/Insufficient balance/i.test(error.message)) return reply({error:"Saldo real insuficiente para essa aposta."},409);
      if (/Wallet not found/i.test(error.message)) return reply({error:"Sua carteira ainda não está pronta."},409);
      console.error("Arcade settlement failed", error.message);
      return reply({error:"Não foi possível finalizar a rodada. Nenhuma aposta foi confirmada se a transação falhou."},500);
    }
    return reply({ ...data, game });
  } catch (e) {
    console.error("Arcade game error", e instanceof Error ? e.message : "unknown");
    return reply({error:"Erro interno no jogo."},500);
  }
});