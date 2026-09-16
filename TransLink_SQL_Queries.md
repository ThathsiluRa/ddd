## IT25103589 — User and Account Management

### See all users

This avoids exposing `password_hash` and other security information:

```
SELECT
  id,
  name,
  email,
  phone,
  role,
  stakeholder_type,
  CASE
    WHEN is_verified = 1 THEN 'Verified'
    ELSE 'Not verified'
  END AS verification,
  account_status,
  datetime(created_at, '+5 hours', '+30 minutes') AS created_at_colombo
FROM users
ORDER BY id DESC;
```

### Find an individual user by ID

Change `1` to the user ID:

```
SELECT
  id,
  name,
  email,
  phone,
  role,
  stakeholder_type,
  is_verified,
  account_status,
  datetime(created_at, '+5 hours', '+30 minutes') AS created_at_colombo,
  datetime(status_changed_at, '+5 hours', '+30 minutes')
    AS status_changed_at_colombo
FROM users
WHERE id = 1;
```

### Find an individual user by email

Change the example email:

```
SELECT
  id,
  name,
  email,
  phone,
  role,
  stakeholder_type,
  is_verified,
  account_status
FROM users
WHERE email = 'demo@example.com' COLLATE NOCASE;
```

### See the number of users in every role

```
SELECT
  role,
  stakeholder_type,
  account_status,
  COUNT(*) AS user_count
FROM users
GROUP BY role, stakeholder_type, account_status
ORDER BY role, stakeholder_type, account_status;
```

### See accounts that require administrator attention

This displays suspended/deleted accounts and users who have not verified their accounts:

```
SELECT
  id,
  name,
  email,
  role,
  stakeholder_type,
  account_status,
  CASE
    WHEN is_verified = 1 THEN 'Verified'
    ELSE 'Not verified'
  END AS verification
FROM users
WHERE account_status <> 'active'
   OR is_verified = 0
ORDER BY account_status, id DESC;
```

### See users who registered today

This calculates “today” using Sri Lankan time:

```
SELECT
  id,
  name,
  email,
  role,
  stakeholder_type,
  datetime(created_at, '+5 hours', '+30 minutes') AS registered_at_colombo
FROM users
WHERE date(created_at, '+5 hours', '+30 minutes') =
      date('now', '+5 hours', '+30 minutes')
ORDER BY created_at DESC;
```

## IT25103579 — Seat Booking Management

### See everyone who booked today

```
SELECT
  b.id AS booking_id,
  b.booking_ref,
  u.id AS user_id,
  u.name AS passenger,
  u.email,
  u.phone,
  r.origin || ' → ' || r.destination AS route,
  datetime(s.departure_time, '+5 hours', '+30 minutes')
    AS departure_colombo,
  group_concat(bs.seat_no, ', ') AS seats,
  b.status,
  printf('LKR %.2f', b.total_amount) AS total,
  datetime(b.created_at, '+5 hours', '+30 minutes')
    AS booked_at_colombo
FROM bookings b
JOIN users u ON u.id = b.user_id
JOIN schedules s ON s.id = b.schedule_id
JOIN routes r ON r.id = s.route_id
LEFT JOIN booking_seats bs ON bs.booking_id = b.id
WHERE date(b.created_at, '+5 hours', '+30 minutes') =
      date('now', '+5 hours', '+30 minutes')
GROUP BY
  b.id,
  b.booking_ref,
  u.id,
  u.name,
  u.email,
  u.phone,
  r.origin,
  r.destination,
  s.departure_time,
  b.status,
  b.total_amount,
  b.created_at
ORDER BY b.created_at DESC;
```

If this returns no rows during the demonstration, nobody has created a booking during the current Sri Lankan calendar day.

### See the booking history of one user

Change `1` to the required user ID:

```
SELECT
  b.booking_ref,
  r.origin || ' → ' || r.destination AS route,
  datetime(s.departure_time, '+5 hours', '+30 minutes')
    AS departure_colombo,
  group_concat(bs.seat_no, ', ') AS seats,
  b.status,
  printf('LKR %.2f', b.total_amount) AS total,
  datetime(b.created_at, '+5 hours', '+30 minutes')
    AS booked_at_colombo
FROM bookings b
JOIN schedules s ON s.id = b.schedule_id
JOIN routes r ON r.id = s.route_id
LEFT JOIN booking_seats bs ON bs.booking_id = b.id
WHERE b.user_id = 1
GROUP BY
  b.id,
  b.booking_ref,
  r.origin,
  r.destination,
  s.departure_time,
  b.status,
  b.total_amount,
  b.created_at
ORDER BY b.created_at DESC;
```

### See bookings grouped by status

```
SELECT
  status,
  COUNT(*) AS booking_count,
  printf('LKR %.2f', COALESCE(SUM(total_amount), 0)) AS total_value
FROM bookings
GROUP BY status
ORDER BY booking_count DESC;
```

### Show the passenger manifest for one schedule

Change `1` to the schedule ID:

```
SELECT
  b.booking_ref,
  u.name AS passenger,
  u.phone,
  group_concat(bs.seat_no, ', ') AS seats,
  b.status
FROM bookings b
JOIN users u ON u.id = b.user_id
JOIN booking_seats bs ON bs.booking_id = b.id
WHERE b.schedule_id = 1
  AND b.status IN ('pending_payment', 'confirmed')
GROUP BY b.id, b.booking_ref, u.name, u.phone, b.status
ORDER BY MIN(bs.seat_no);
```

## IT25103580 — Route and Schedule Management

### See all upcoming schedules

```
SELECT
  s.id AS schedule_id,
  r.origin || ' → ' || r.destination AS route,
  b.registration_no AS bus,
  d.name AS driver,
  datetime(s.departure_time, '+5 hours', '+30 minutes')
    AS departure_colombo,
  datetime(s.arrival_time, '+5 hours', '+30 minutes')
    AS arrival_colombo,
  printf('LKR %.2f', s.price) AS ticket_price,
  s.schedule_type,
  s.status
FROM schedules s
JOIN routes r ON r.id = s.route_id
JOIN buses b ON b.id = s.bus_id
LEFT JOIN drivers d ON d.id = s.driver_id
WHERE datetime(s.departure_time) >= datetime('now')
ORDER BY s.departure_time;
```

### See seat availability for each upcoming schedule

```
SELECT
  s.id AS schedule_id,
  r.origin || ' → ' || r.destination AS route,
  datetime(s.departure_time, '+5 hours', '+30 minutes')
    AS departure_colombo,
  b.registration_no,
  b.seat_count AS capacity,
  COUNT(
    DISTINCT CASE
      WHEN bk.status IN ('pending_payment', 'confirmed')
      THEN bs.seat_no
    END
  ) AS reserved_seats,
  b.seat_count - COUNT(
    DISTINCT CASE
      WHEN bk.status IN ('pending_payment', 'confirmed')
      THEN bs.seat_no
    END
  ) AS available_seats
FROM schedules s
JOIN routes r ON r.id = s.route_id
JOIN buses b ON b.id = s.bus_id
LEFT JOIN booking_seats bs ON bs.schedule_id = s.id
LEFT JOIN bookings bk ON bk.id = bs.booking_id
WHERE datetime(s.departure_time) >= datetime('now')
  AND s.status = 'scheduled'
GROUP BY
  s.id,
  r.origin,
  r.destination,
  s.departure_time,
  b.registration_no,
  b.seat_count
ORDER BY s.departure_time;
```

### Rank the most popular routes

```
SELECT
  r.id AS route_id,
  r.origin || ' → ' || r.destination AS route,
  COUNT(
    DISTINCT CASE
      WHEN b.status = 'confirmed' THEN b.id
    END
  ) AS confirmed_bookings,
  printf(
    'LKR %.2f',
    COALESCE(
      SUM(
        CASE
          WHEN b.status = 'confirmed' THEN b.total_amount
          ELSE 0
        END
      ),
      0
    )
  ) AS booked_revenue
FROM routes r
LEFT JOIN schedules s ON s.route_id = r.id
LEFT JOIN bookings b ON b.schedule_id = s.id
GROUP BY r.id, r.origin, r.destination
ORDER BY confirmed_bookings DESC, route;
```

## IT25103547 — Payment and Refund Management

### See all payment transactions

```
SELECT
  p.id AS payment_id,
  b.booking_ref,
  u.name AS passenger,
  p.provider,
  p.provider_ref,
  printf('LKR %.2f', p.amount) AS amount,
  p.status,
  datetime(p.created_at, '+5 hours', '+30 minutes')
    AS created_at_colombo,
  datetime(p.updated_at, '+5 hours', '+30 minutes')
    AS updated_at_colombo
FROM payments p
JOIN bookings b ON b.id = p.booking_id
JOIN users u ON u.id = b.user_id
ORDER BY p.id DESC;
```

### See today’s successful payments and revenue

```
SELECT
  COUNT(*) AS paid_transactions_today,
  printf('LKR %.2f', COALESCE(SUM(amount), 0)) AS revenue_today
FROM payments
WHERE status = 'paid'
  AND date(updated_at, '+5 hours', '+30 minutes') =
      date('now', '+5 hours', '+30 minutes');
```

### See failed and pending payments

```
SELECT
  p.id AS payment_id,
  b.booking_ref,
  u.name AS passenger,
  u.email,
  p.provider,
  p.status,
  printf('LKR %.2f', p.amount) AS amount,
  datetime(p.updated_at, '+5 hours', '+30 minutes')
    AS updated_at_colombo
FROM payments p
JOIN bookings b ON b.id = p.booking_id
JOIN users u ON u.id = b.user_id
WHERE p.status IN ('pending', 'failed')
ORDER BY p.updated_at DESC;
```

### See refunds waiting for action

```
SELECT
  rf.id AS refund_id,
  b.booking_ref,
  u.name AS requested_by,
  rf.reason,
  printf('LKR %.2f', rf.amount) AS amount,
  rf.status,
  datetime(rf.created_at, '+5 hours', '+30 minutes')
    AS requested_at_colombo
FROM refunds rf
JOIN bookings b ON b.id = rf.booking_id
JOIN users u ON u.id = rf.requested_by
WHERE rf.status IN ('pending', 'approved')
ORDER BY rf.created_at;
```

## IT25103562 — Fleet Management

### List all buses

```
SELECT
  id,
  registration_no,
  model,
  seat_count,
  status,
  next_service_date
FROM buses
ORDER BY registration_no;
```

### See maintenance scheduled during the next 30 days

```
SELECT
  m.id AS maintenance_id,
  b.registration_no,
  b.model,
  m.maintenance_type,
  m.scheduled_date,
  m.status,
  m.notes
FROM maintenance m
JOIN buses b ON b.id = m.bus_id
WHERE date(m.scheduled_date)
      BETWEEN date('now') AND date('now', '+30 days')
  AND m.status IN ('scheduled', 'in_progress')
ORDER BY date(m.scheduled_date), b.registration_no;
```

### See driver licences expiring during the next 90 days

```
SELECT
  id,
  name,
  license_no,
  license_expiry,
  phone,
  status
FROM drivers
WHERE license_expiry IS NOT NULL
  AND date(license_expiry)
      BETWEEN date('now') AND date('now', '+90 days')
ORDER BY date(license_expiry);
```

### See total fuel usage and cost for each bus

```
SELECT
  b.registration_no,
  COUNT(f.id) AS fuel_entries,
  ROUND(COALESCE(SUM(f.litres), 0), 2) AS total_litres,
  printf('LKR %.2f', COALESCE(SUM(f.cost), 0)) AS total_fuel_cost
FROM buses b
LEFT JOIN fuel_records f ON f.bus_id = b.id
GROUP BY b.id, b.registration_no
ORDER BY COALESCE(SUM(f.cost), 0) DESC;
```

## IT25103576 — Support Tickets and Feedback

### See all customer-support tickets

```
SELECT
  c.id AS ticket_id,
  u.name AS customer,
  u.email,
  b.booking_ref,
  c.category,
  c.status,
  substr(c.message, 1, 100) AS issue_preview,
  datetime(c.created_at, '+5 hours', '+30 minutes')
    AS opened_at_colombo,
  datetime(c.updated_at, '+5 hours', '+30 minutes')
    AS updated_at_colombo
FROM complaints c
JOIN users u ON u.id = c.user_id
LEFT JOIN bookings b ON b.id = c.booking_id
ORDER BY c.id DESC;
```

### See unresolved support tickets

```
SELECT
  c.id AS ticket_id,
  u.name AS customer,
  u.email,
  c.category,
  c.status,
  c.message,
  datetime(c.created_at, '+5 hours', '+30 minutes')
    AS opened_at_colombo
FROM complaints c
JOIN users u ON u.id = c.user_id
WHERE c.status IN ('open', 'in_progress')
ORDER BY
  CASE c.status
    WHEN 'open' THEN 1
    ELSE 2
  END,
  c.created_at;
```

### See all passenger ratings

```
SELECT
  f.id AS feedback_id,
  u.name AS passenger,
  b.booking_ref,
  f.rating,
  f.comment,
  datetime(f.created_at, '+5 hours', '+30 minutes')
    AS submitted_at_colombo
FROM feedback f
JOIN users u ON u.id = f.user_id
LEFT JOIN bookings b ON b.id = f.booking_id
ORDER BY f.id DESC;
```

### See average ratings by route

```
SELECT
  r.origin || ' → ' || r.destination AS route,
  COUNT(f.id) AS review_count,
  ROUND(AVG(f.rating), 2) AS average_rating
FROM feedback f
JOIN bookings b ON b.id = f.booking_id
JOIN schedules s ON s.id = b.schedule_id
JOIN routes r ON r.id = s.route_id
GROUP BY r.id, r.origin, r.destination
ORDER BY average_rating DESC, review_count DESC;
```

## Strong final demonstration query

This gives the instructor a one-row overview of the whole system:

```
SELECT
  (
    SELECT COUNT(*)
    FROM users
    WHERE account_status = 'active'
  ) AS active_users,

  (
    SELECT COUNT(*)
    FROM bookings
    WHERE date(created_at, '+5 hours', '+30 minutes') =
          date('now', '+5 hours', '+30 minutes')
  ) AS bookings_today,

  (
    SELECT COUNT(*)
    FROM payments
    WHERE status = 'paid'
      AND date(updated_at, '+5 hours', '+30 minutes') =
          date('now', '+5 hours', '+30 minutes')
  ) AS paid_transactions_today,

  (
    SELECT ROUND(COALESCE(SUM(amount), 0), 2)
    FROM payments
    WHERE status = 'paid'
      AND date(updated_at, '+5 hours', '+30 minutes') =
          date('now', '+5 hours', '+30 minutes')
  ) AS revenue_today_lkr,

  (
    SELECT COUNT(*)
    FROM complaints
    WHERE status IN ('open', 'in_progress')
  ) AS unresolved_tickets,

  (
    SELECT ROUND(AVG(rating), 2)
    FROM feedback
  ) AS average_rating;
```

The complete SQL file contains additional queries for active sessions, registrations today, seven-day booking reports, schedule manifests, route popularity, daily payment revenue, repair expenses, unavailable buses and drivers, complete support-ticket conversations, rating distributions, and foreign-key integrity checks.
