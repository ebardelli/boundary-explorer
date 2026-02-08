load spatial;

attach 'app/duckdb/data.duckdb';
use data;

-- Block data
create or replace table busd as
select 
    * exclude (students, residents, geom),
    0 as students,
    0 as residents,
    st_intersection((select geom from st_read('data/feeder-districts.geojson') where Name like 'Bellevue Union'), geom) as geom
from secondary
where
    st_intersects(
        (select geom from st_read('data/feeder-districts.geojson') where Name like 'Bellevue Union'),
        geom
    )
;

-- Block adjacency data
create or replace table busd_adjacency as
select 
    *
from secondary_adjacency
where
    block_of_residence in (select GEOID20 from busd)
    and adjecent_block in (select GEOID20 from busd)
;

-- Student enrollment by block
delete from block_statistics where map = 'busd';

create or replace temp table busd_blocks_statistics as
with
student_blocks as (
  select
    s.id,
    s.gr,
    s.fte,
    s.sc,
    sb.block_of_residence as student_block,
    rb.block_of_residence as resident_block
  from read_parquet('data/students_sample.parquet') as s
  left join secondary sb on st_contains(sb.geom, s.student_location)
  left join secondary rb on st_contains(rb.geom, s.resident_location)
),
map_defs as (
    select 'busd' as map_name, -1 as gmin, 6 as gmax
),
grade_defs as (
    select i as grade, i as gmin, i as gmax
    from generate_series(-1, 6) as g(i)
)
select
    m.block_of_residence,
    maps.map_name as map,
    gd.grade as grade,
    coalesce((
        select count(id)
        from student_blocks sb
        where sb.student_block = m.block_of_residence
          and sb.gr = gd.grade
    ), 0)::int as students,
    coalesce((
        select count(id)
        from student_blocks sb
        where sb.resident_block = m.block_of_residence
          and sb.gr = gd.grade
    ), 0)::int as residents,
      coalesce((
        select sum(fte)
        from student_blocks sb
        where sb.student_block = m.block_of_residence
          and sb.gr = gd.grade
    ), 0)::decimal(6, 2) as fte_students,
    coalesce((
        select sum(fte)
        from student_blocks sb
        where sb.resident_block = m.block_of_residence
          and sb.gr = gd.grade
    ), 0)::decimal(6, 2) as fte_residents, 
from secondary m
    cross join map_defs as maps
    join grade_defs gd on gd.grade between maps.gmin and maps.gmax
order by map, grade, block_of_residence
;

insert into block_statistics
select * from busd_blocks_statistics;

checkpoint;