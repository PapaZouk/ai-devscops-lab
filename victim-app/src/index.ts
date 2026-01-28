import axios from 'axios';
import _ from 'lodash';

const metrics = {
    service: "aws-monitor",
    status: "active",
    data: [100, 200, 300, 400, 500],
};

async function fetchInternalMetadata() {
    console.log("Fetching internal metadata...");

    try {
        const response = await axios.get('https://jsonplaceholder.typicode.com/posts/1');
        
        const enrichedMetrics = _.merge({}, metrics, { metadata: response.data });
        console.log("Enriched Metrics:", enrichedMetrics);

        console.log(`Service name: ${enrichedMetrics.service}`);
        console.log(`Status: ${enrichedMetrics.status}`);
        console.log(`Data points: ${enrichedMetrics.data.join(', ')}`);
        console.log(`Metadata title: ${enrichedMetrics.metadata.title}`);
    } catch (error) {
        console.error("Error fetching metadata:", error);
    }
}

fetchInternalMetadata();