load spatial;

create or replace temporary table student as
SELECT
    1 as id,
    1 as sc,
    1 as gr,
    1 / 25 as fte,
    'Sample address' as rad,
    'I' as it,
    st_point(-122, 34) as school_location,
    st_point(-121, 33) as student_location,
    st_point(-120, 32) as resident_location
;

copy student to 'data/students_sample.parquet';