ALTER TABLE workshops DROP CONSTRAINT workshops_name_check;
ALTER TABLE workshops ADD CONSTRAINT workshops_name_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 200);

UPDATE workshops w SET name = btrim(p.trade_name)
FROM workshop_billing_profiles p
WHERE p.workshop_id = w.id AND p.trade_name IS NOT NULL
  AND w.name IS DISTINCT FROM btrim(p.trade_name);

UPDATE workshop_billing_profiles p SET trade_name = w.name
FROM workshops w
WHERE w.id = p.workshop_id AND p.trade_name IS DISTINCT FROM w.name;
