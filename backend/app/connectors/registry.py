from __future__ import annotations

from .base import Connector, ConnectorSpec
from . import catalog, impl
from .databricks import DatabricksConnector

CONNECTORS: dict[str, type[Connector]] = {
    c.spec.id: c
    for c in [
        impl.FileConnector,
        impl.SalesforceConnector, impl.SapConnector, impl.ServiceNowConnector, impl.WorkdayConnector, impl.HubSpotConnector,
        *[c for c in catalog.CATALOG_CONNECTORS if c.spec.category == "application"],
        DatabricksConnector, impl.SnowflakeConnector, impl.RedshiftConnector, impl.SynapseConnector,
        *[c for c in catalog.CATALOG_CONNECTORS if c.spec.category == "warehouse"],
        impl.SqlServerConnector, impl.AzureSqlConnector, impl.OracleConnector, impl.PostgresConnector, impl.MySqlConnector, impl.MariaDbConnector,
        impl.Db2Connector, impl.SapHanaConnector, impl.TeradataConnector, impl.SybaseConnector, impl.CockroachConnector, impl.JdbcConnector,
        impl.S3Connector, impl.AdlsConnector, impl.BlobConnector, impl.GcsConnector, *catalog.STORAGE_CONNECTORS, impl.SftpConnector,
        *[c for c in catalog.CATALOG_CONNECTORS if c.spec.category in ("streaming", "nosql")],
        impl.RestApiConnector, impl.GraphQLConnector,
    ]
}


def list_specs() -> list[ConnectorSpec]:
    return [c.spec for c in CONNECTORS.values()]


def get_connector_class(connector_id: str) -> type[Connector]:
    if connector_id not in CONNECTORS:
        from ..core.errors import FriendlyError

        raise FriendlyError("Unknown source", f"'{connector_id}' isn't a supported source yet.", status_code=404)
    return CONNECTORS[connector_id]
