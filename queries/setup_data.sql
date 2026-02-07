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

checkpoint;