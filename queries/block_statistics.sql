-- Note that this file needs a student database in parquet file with the following column:
-- id, gr, fte, sc, student_location, resident_location
load spatial;

-- Load base maps
create or replace table elementary as select * from st_read('data/srcs-elementary-blocks.geojson') order by block_of_residence;

create or replace table middle as select * from st_read('data/srcs-secondary-blocks.geojson') order by block_of_residence;

create or replace table high as select * from st_read('data/srcs-secondary-blocks.geojson') order by block_of_residence;

create or replace table secondary as select * from st_read('data/srcs-secondary-blocks.geojson') order by block_of_residence;

-- Load schools
create or replace table schools as 
select
    name,
    latitude::DOUBLE as latitude,
    longitude::DOUBLE as longitude,
    enrollment as capacity,
    fte as fte_capacity,
from read_json('data/srcs-schools.json');

-- Precompute adjecency
create or replace table elementary_adjacency as
select 
    elementary.block_of_residence,
    adjecent.block_of_residence as adjecent_block
from elementary
    join elementary as adjecent on st_touches(elementary.geom, adjecent.geom)
order by elementary.block_of_residence
;

create or replace table middle_adjacency as
select 
    middle.block_of_residence,
    adjecent.block_of_residence as adjecent_block
from middle
    join middle as adjecent on st_touches(middle.geom, adjecent.geom)
order by middle.block_of_residence
;

create or replace table high_adjacency as
select 
    high.block_of_residence,
    adjecent.block_of_residence as adjecent_block
from high
    join high as adjecent on st_touches(high.geom, adjecent.geom)
order by high.block_of_residence
;

create or replace table secondary_adjacency as
select 
    secondary.block_of_residence,
    adjecent.block_of_residence as adjecent_block
from secondary
    join secondary as adjecent on st_touches(secondary.geom, adjecent.geom)
order by secondary.block_of_residence
;

attach 'app/duckdb/data.duckdb';
use data;

create or replace table block_statistics as
with
student_blocks as (
  select
    s.id,
    s.gr,
    s.fte,
    s.sc,
    sb.block_of_residence as student_block,
    rb.block_of_residence as resident_block
  from read_parquet('data/students.parquet') as s
  left join secondary sb on st_contains(sb.geom, s.student_location)
  left join secondary rb on st_contains(rb.geom, s.resident_location)
),
map_defs as (
    select 'elementary' as map_name, -1 as gmin, 6 as gmax
    union all select 'middle', 7, 8
    union all select 'high', 9, 12
    union all select 'secondary', 7, 12
),
grade_defs as (
    select i as grade, i as gmin, i as gmax
    from generate_series(-1, 12) as g(i)
),
all_maps as (
    select * from map_defs
)
select
    m.block_of_residence,
    am.map_name as map,
    gd.grade as grade,
    coalesce((
        select count(id)
        from student_blocks sb
        where sb.student_block = m.block_of_residence
          and sb.gr = gd.grade
          and sb.sc not between 20 and 23
    ), 0)::int as students,
    coalesce((
        select count(id)
        from student_blocks sb
        where sb.resident_block = m.block_of_residence
          and sb.gr = gd.grade
          and sb.sc not between 20 and 23
    ), 0)::int as residents,
      coalesce((
        select sum(fte)
        from student_blocks sb
        where sb.student_block = m.block_of_residence
          and sb.gr = gd.grade
          and sb.sc not between 20 and 23
    ), 0)::decimal(6, 2) as fte_students,
    coalesce((
        select sum(fte)
        from student_blocks sb
        where sb.resident_block = m.block_of_residence
          and sb.gr = gd.grade
          and sb.sc not between 20 and 23
    ), 0)::decimal(6, 2) as fte_residents, 
from secondary m
  cross join all_maps am
  join grade_defs gd on gd.grade between am.gmin and am.gmax
order by map, grade, block_of_residence
;

checkpoint;
