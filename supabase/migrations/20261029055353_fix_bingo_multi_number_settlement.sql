-- Corrige a liquidação do Bingo 100 quando o jogador seleciona vários números.
-- O débito é o valor por número multiplicado pela quantidade selecionada;
-- o prêmio é 100x apenas o valor da aposta no número sorteado.
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
  v_bingo_per_number integer;
  v_bingo_count integer;
  v_bingo_drawn integer;
  v_bingo_won boolean;
  v_bingo_hit boolean;
BEGIN
  IF p_user_id IS NULL OR p_round_id IS NULL THEN
    RAISE EXCEPTION 'Invalid player or round';
  END IF;

  IF p_game_key NOT IN (
    'mega_slots_real','roulette_real','fortune_wheel_real','bingo_real',
    'crash_vegas_real','plinko_neon_real'
  ) THEN
    RAISE EXCEPTION 'Unsupported game';
  END IF;

  IF p_game_key = 'bingo_real' THEN
    IF p_stake_cents IS NULL OR p_stake_cents < 100 OR
       p_stake_cents > 2000000 OR p_stake_cents % 100 <> 0 THEN
      RAISE EXCEPTION 'Invalid bingo total stake';
    END IF;

    IF jsonb_typeof(p_result->'selected_numbers') <> 'array' OR
       jsonb_array_length(p_result->'selected_numbers') < 1 OR
       jsonb_array_length(p_result->'selected_numbers') > 100 THEN
      RAISE EXCEPTION 'Invalid bingo selection';
    END IF;

    v_bingo_per_number := nullif(p_result->>'per_number_stake_cents','')::integer;
    v_bingo_count := jsonb_array_length(p_result->'selected_numbers');
    v_bingo_drawn := nullif(p_result->>'drawn_number','')::integer;
    v_bingo_won := nullif(p_result->>'won','')::boolean;

    IF v_bingo_per_number NOT IN (100,200,300,400,500,1000,2000,3000,4000,5000,10000,20000)
       OR v_bingo_drawn IS NULL OR v_bingo_drawn < 1 OR v_bingo_drawn > 100
       OR v_bingo_won IS NULL THEN
      RAISE EXCEPTION 'Invalid bingo result';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p_result->'selected_numbers') AS item(value)
      WHERE item.value !~ '^[0-9]{1,3}$'
         OR item.value::integer < 1
         OR item.value::integer > 100
    ) THEN
      RAISE EXCEPTION 'Invalid bingo number';
    END IF;

    IF (SELECT count(DISTINCT item.value::integer)
        FROM jsonb_array_elements_text(p_result->'selected_numbers') AS item(value)) <> v_bingo_count THEN
      RAISE EXCEPTION 'Duplicate bingo number';
    END IF;

    IF p_stake_cents <> v_bingo_per_number * v_bingo_count THEN
      RAISE EXCEPTION 'Bingo total stake does not match selection';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p_result->'selected_numbers') AS item(value)
      WHERE item.value::integer = v_bingo_drawn
    ) INTO v_bingo_hit;

    IF v_bingo_won IS DISTINCT FROM v_bingo_hit THEN
      RAISE EXCEPTION 'Bingo result does not match selected numbers';
    END IF;

    IF p_payout_cents IS DISTINCT FROM
       (CASE WHEN v_bingo_won THEN v_bingo_per_number * 100 ELSE 0 END) THEN
      RAISE EXCEPTION 'Invalid bingo payout';
    END IF;
  ELSE
    IF p_stake_cents NOT IN (50,100,200,500,1000,2000,5000,10000) THEN
      RAISE EXCEPTION 'Invalid stake';
    END IF;
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

  INSERT INTO public.wallet_transactions(user_id,type,amount,description)
  VALUES (p_user_id,'bet',-v_stake,'Aposta real: '||p_game_key);

  IF v_payout > 0 THEN
    UPDATE public.wallets
    SET balance = balance + v_payout, updated_at = now()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.wallet_transactions(user_id,type,amount,description)
    VALUES (p_user_id,'payout',v_payout,'Prêmio real: '||p_game_key);
  END IF;

  INSERT INTO public.cassino_game_rounds(id,user_id,game_key,stake_cents,payout_cents,result)
  VALUES (p_round_id,p_user_id,p_game_key,p_stake_cents,p_payout_cents,coalesce(p_result,'{}'::jsonb));

  SELECT balance INTO v_new_balance
  FROM public.wallets
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok',true,'round_id',p_round_id,'stake',v_stake,'payout',v_payout,
    'balance',v_new_balance,'result',coalesce(p_result,'{}'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_cassino_arcade_round(uuid, uuid, text, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_cassino_arcade_round(uuid, uuid, text, integer, integer, jsonb) TO service_role;
