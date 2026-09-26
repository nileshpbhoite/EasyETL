from __future__ import annotations

from .base import Connector, ConnectorSpec
from . import impl

CONNECTORS: dict[str, type[Connector]] = {
    c.spec.id: c
    for c in [
        impl.FileConnector,
        impl.SalesforceConnector, impl.SapConnector, impl.ServiceNowConnector, impl.WorkdayConnector,
        impl.SnowflakeConnector, impl.HubSpotConnector, impl.SftpConnector,
        impl.SqlServerConnector, impl.OracleConnector, impl.PostgresConnector, impl.MySqlConnector, impl.JdbcConnector,
        impl.AdlsConnector, impl.BlobConnector, impl.S3Connector, impl.GcsConnector,
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
