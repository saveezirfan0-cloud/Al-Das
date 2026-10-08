-- LOCAL TEST STUB: records requests instead of sending them.
create table net.http_request_queue (
  id bigint generated always as identity primary key,
  method text, url text, headers jsonb, body bytea, timeout_milliseconds integer,
  created timestamptz default now()
);
create table net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz default now()
);
create function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds)
  returning id into v_id;
  return v_id;
end $$;
