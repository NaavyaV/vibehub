-- Remap legacy claimed/blocked rows to available (public: Assigned).
-- Status CHECK stays unchanged; the API maps available→assigned, in_progress→working, merged→done.

UPDATE features SET status = 'available' WHERE status IN ('claimed', 'blocked');
