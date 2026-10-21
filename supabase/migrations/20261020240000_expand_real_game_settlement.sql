-- Cassino Las Vegas: migração de proteção da liquidação da carteira real.
-- NÃO habilitar novos jogos nesta função antes de implantar e validar a lógica server-side.
-- Este arquivo não é executado automaticamente pelo GitHub Pages.
-- Mantém apenas os três jogos cuja função Edge já calcula o resultado no servidor.
CREATE OR REPLACE FUNCTION public.settle_cassino_arcade_round(
  p_user_id uuid,
  p_round_id uuid,
  p_game_key text,
  p_stake_cents integer,
  p_payout_cents integer,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric;
  v_stake numeric;
  v_payout numeric;
  v_new_balance numeric;
BEGIN
  IF p_user_id IS NULL OR p_round_id IS NULL THEN
    RAISE EXCEPTION 'Invalid player or round';
  END IF;

  IF p_game_key NOT IN (
    'mega_slots_real',
    'roulette_real',
    'fortune_wheel_real'
  ) THEN
    RAISE EXCEPTION 'Unsupported game';
  END IF;

  IF p_stake_cents NOT IN (50,100,200,500,1000,2000,5000,10000) THEN
    RAISE EXCEPTION 'Invalid stake';
  END IF;

  IF p_payout_cents IS NULL OR p_payout_cents < 0 OR p_payout_cents > p_stake_cents * 250 THEN
    RAISE EXCEPTION 'Invalid payout';
  END IF;

  IF EXISTS (SELECT 1 FROM public.cassino_game_rounds WHERE id = p_round_id) THEN
    RAISE EXCEPTION 'Duplicate round';
  END IF;

  v_stake := p_stake_cents::numeric / 100;
  v_payout := p_payout_cents::numeric / 100;

  SELECT balance INTO v_balance
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  IF v_balance < v_stake THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.wallets
  SET balance = balance - v_stake, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions(user_id, type, amount, description)
  VALUES (p_user_id, 'bet', -v_stake, 'Aposta real: ' || p_game_key);

  IF v_payout > 0 THEN
    UPDATE public.wallets
    SET balance = balance + v_payout, updated_at = now()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.wallet_transactions(user_id, type, amount, description)
    VALUES (p_user_id, 'payout', v_payout, 'Prêmio real: ' || p_game_key);
  END IF;

  INSERT INTO public.cassino_game_rounds(id, user_id, game_key, stake_cents, payout_cents, result)
  VALUES (p_round_id, p_user_id, p_game_key, p_stake_cents, p_payout_cents, coalesce(p_result, '{}'::jsonb));

  SELECT balance INTO v_new_balance
  FROM public.wallets
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', p_round_id,
    'stake', v_stake,
    'payout', v_payout,
    'balance', v_new_balance,
    'result', coalesce(p_result, '{}'::jsonb)
  );
END;
$function$;

-- A liquidação só deve ser chamada pela Edge Function autenticada com service_role.
REVOKE ALL ON FUNCTION public.settle_cassino_arcade_round(uuid, uuid, text, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_cassino_arcade_round(uuid, uuid, text, integer, integer, jsonb) TO service_role;
