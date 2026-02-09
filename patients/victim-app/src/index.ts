import axios from 'axios';
import _ from 'lodash';

export const metrics = {
    service: "aws-monitor",
    status: "active",
    data: [100, 200, 300, 400, 500],
};

export async function fetchInternalMetadata() {
    console.log("Fetching internal metadata...");

    try {
        const response = await axios.default.get('https://jsonplaceholder.typicode.com/posts/1');
        const enrichedMetrics = _.merge({}, metrics, { metadata: response.data });

        return enrichedMetrics;
    } catch (error) {
        console.error("Error fetching metadata:", error);
    }
}

fetchInternalMetadata();